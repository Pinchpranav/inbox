// relay.ts — capture pi AgentSession events, PERSIST them to the store
// (persist-first, t3code ordering), THEN PUBLISH them onto the in-memory bus.
//
// Step 5 adds the publish step: after each durable write, emit the same event
// on the bus so a decoupled subscriber (test now, WebSocket later) receives it
// live. This proves the DB write and the live push are two consumers of the
// same event — the decoupling check.
//
// COALESCING (build-359): one WS frame per token (~70/sec through nginx +
// Cloudflare) is the round-trip-count bottleneck, not volume. Deltas are
// buffered in memory; a 1s interval persists the buffer as ONE streaming
// chunk (message.sent) and emits ONE bus event — the durable write still
// happens BEFORE its frame leaves (persist-first invariant). text_end
// REPLACES in the projection as before, so history is unaffected. Abort is
// untouched: the relay only ever settles on text_end, so the trailing buffer
// never reaches the DB — same as today for an abort before text_end.
//
// ── FLOW (who calls what) ─────────────────────────────────────────────
//   chat.ts (WS route, build-cqf) is the ONLY caller of this file:
//     1. recordUserMessage(store, key, text)   — persist the user's prompt
//        BEFORE the engine runs (t3code ordering).
//     2. attachAssistantRelay(store, key, session) — subscribe to the engine's
//        event stream; COALESCE deltas in memory, persist + publish the
//        accumulated chunk once per second.
//     3. await handle.session.prompt(text)      — run the engine (this is what
//        fires the subscribe callback below).
//     4. await relay.finished                   — resolves when text_end fires.
//   The user's own message is persisted but NOT published (the browser already
//   rendered it). The bus carries only assistant output.
import type { StateStore } from "./stateStore.ts";
import { bus, EVENT, type BusEvent } from "./bus.ts";

/**
 * What `finished` in function attachAssistantRelay resolves with when a turn completes.
 * Consumed by chat.ts (it awaits relay.finished to know the turn is done).
 */
export interface RelayResult {
  streamedText: string;
  assistantMessageId: string;
}

/** The shape of the assistant-message sub-event inside a pi message_update. */
interface AssistantMessageEvent {
  type: string;
  delta?: string;
  content?: string;
}

/** The pi SDK event shape the relay listens for (only message_update matters). */
interface PiEvent {
  type: string;
  assistantMessageEvent?: AssistantMessageEvent;
}

/**
 * The handle attachAssistantRelay returns. Consumed by chat.ts:
 *   - `finished`  — a promise that resolves with RelayResult at text_end.
 *   - `unsubscribe` — detach the relay from the session (cleanup).
 */
export interface AttachedRelay {
  finished: Promise<RelayResult>;
  unsubscribe(): void;
}

/**
 * Persist a user prompt as a message BEFORE invoking the engine (t3code ordering),
 * then publish it on the bus.
 * Called by chat.ts once per prompt, before it runs the engine.
 * Returns the messageId (so the caller can track it).
 */
export function recordUserMessage(store: StateStore, sessionKey: string, text: string): string {
  const messageId = `msg-user-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const sequence = store.write({
    type: "message.sent",
    payload: { messageId, role: "user", text, sessionKey },
  });
  // `emit` here is the helper function defined below, NOT bus.emit directly.
  // The helper wraps bus.emit(EVENT, ev) so call sites stay short.
  emit({ sessionKey, kind: "message.sent", messageId, role: "user", text, sequence });
  return messageId;
}

/**
 * Publish a bus event (persist has already happened by the caller).
 * Internal helper — wraps bus.emit(EVENT, ev). Not exported.
 */
function emit(ev: Omit<BusEvent, "sessionKey"> & { sessionKey: string }): void {
  bus.emit(EVENT, ev as BusEvent);
}

/**
 * Attach to an AgentSession, PERSIST its output persist-first, THEN publish
 * each event to the bus (build-359 coalesced):
 *   text_delta -> buffered in memory; a 1s interval persists + publishes
 *                 the accumulated chunk as ONE "message.delta" (one WS frame/sec)
 *   text_end   -> persist + publish "message.end" (final full text)
 * Returns a handle whose `finished` promise resolves with the streamed text.
 *
 * Called by chat.ts ONCE per prompt, BEFORE the engine runs. The `session`
 * passed in is the AgentSession from piSession.open(). The subscribe callback
 * below fires each time the engine emits an event (triggered by
 * session.prompt(text)).
 */
export function attachAssistantRelay(store: StateStore, sessionKey: string, session: {
  subscribe(cb: (ev: PiEvent) => void): () => void;
}): AttachedRelay {
  let assistantId: string | null = null;
  let streamed = "";
  // build-359: buffer for the coalescing interval (see flushInterval below).
  let buffer = "";
  // this resolveFinished is used on the else-if of text_end
  let resolveFinished: (r: RelayResult) => void = () => {};
  const finished = new Promise<RelayResult>((res) => (resolveFinished = res));

  // build-359: persist + publish the accumulated buffer as ONE streaming chunk.
  // Called by the 1s interval (and reused by nothing else). The durable write
  // happens here BEFORE the bus event — persist-first invariant is preserved.
  const flush = () => {
    if (!assistantId || buffer.length === 0) return;
    const chunk = buffer;
    buffer = "";
    const sequence = store.write({
      type: "message.sent",
      payload: { messageId: assistantId, role: "assistant", text: chunk, streaming: true, sessionKey },
    });
    emit({ sessionKey, kind: "message.delta", messageId: assistantId, role: "assistant", text: chunk, streaming: true, sequence });
  };
  // build-359: one frame per second instead of one per token (~70/sec).
  // The interval is cleared at text_end (the terminal event) AND in
  // unsubscribe() — abort never fires text_end, so without the second clear
  // an aborted turn would leak the timer and could flush one ghost
  // message.delta after the "aborted" status (build-359 review).
  const flushInterval = setInterval(flush, 1000);

  const unsubscribe = session.subscribe((ev: PiEvent) => {
    if (ev.type !== "message_update" || !ev.assistantMessageEvent) return;
    const ae = ev.assistantMessageEvent;

    if (ae.type === "text_start") {
      // Begin a new assistant message: allocate its id, reset the buffers.
      // No store write yet — the first interval flush creates the row.
      assistantId = `msg-assistant-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      streamed = "";
      buffer = "";
    } else if (ae.type === "text_delta" && assistantId) {
      // A streaming chunk: append to the in-memory buffer. Nothing is written
      // or published until the 1s interval flushes it (build-359).
      streamed += ae.delta ?? "";
      buffer += ae.delta ?? "";
    } else if (ae.type === "text_end" && assistantId) {
      // Turn finished: settle with the final full text (REPLACES the streaming
      // buffer in the projection), publish, then resolve `finished`.
      // The clear here is the crux: the relay is one-shot, so the timer must
      // die at the exact moment the turn ends, or it leaks forever.
      clearInterval(flushInterval);
      // build-359: drop anything still sitting in the coalescing buffer — the
      // final write below carries the full text and replaces it in the
      // projection (same behavior as pre-coalescing for text_end).
      buffer = "";
      const full = ae.content ?? streamed;
      const sequence = store.write({
        type: "message.sent",
        payload: { messageId: assistantId, role: "assistant", text: full, sessionKey },
      });
      emit({ sessionKey, kind: "message.end", messageId: assistantId, role: "assistant", text: full, sequence });
      resolveFinished({ streamedText: streamed, assistantMessageId: assistantId });
      assistantId = null;
    }
  });

  // build-359 review: unsubscribe() is the single deterministic cleanup
  // point chat.ts calls in `finally` on BOTH paths (normal + abort). Clearing
  // the interval here (idempotent alongside the text_end clear) guarantees
  // the timer dies on abort too, and that no ghost flush can fire after the
  // turn's terminal frame.
  return {
    finished,
    unsubscribe: () => {
      clearInterval(flushInterval);
      unsubscribe();
    },
  };
}
