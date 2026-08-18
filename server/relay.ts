// relay.ts — capture pi AgentSession events, PERSIST them to the store
// (persist-first, t3code ordering), THEN PUBLISH them onto the in-memory bus.
//
// Step 5 adds the publish step: after each durable write, emit the same event
// on the bus so a decoupled subscriber (test now, WebSocket later) receives it
// live. This proves the DB write and the live push are two consumers of the
// same event — the decoupling check.
//
// ── FLOW (who calls what) ─────────────────────────────────────────────
//   chat.ts (WS route, build-cqf) is the ONLY caller of this file:
//     1. recordUserMessage(store, key, text)   — persist the user's prompt
//        BEFORE the engine runs (t3code ordering).
//     2. attachAssistantRelay(store, key, session) — subscribe to the engine's
//        event stream; persist + publish each assistant delta/end.
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
 * each event to the bus:
 *   text_delta -> persist + publish "message.delta"
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
  // this resolveFinished is used on the else-if of text_end
  let resolveFinished: (r: RelayResult) => void = () => {};
  const finished = new Promise<RelayResult>((res) => (resolveFinished = res));

  const unsubscribe = session.subscribe((ev: PiEvent) => {
    if (ev.type !== "message_update" || !ev.assistantMessageEvent) return;
    const ae = ev.assistantMessageEvent;

    if (ae.type === "text_start") {
      // Begin a new assistant message: allocate its id, reset the buffer.
      // No store write yet — the first text_delta creates the row.
      assistantId = `msg-assistant-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      streamed = "";
    } else if (ae.type === "text_delta" && assistantId) {
      // A streaming chunk: append to the buffer, persist (streaming APPENDS in
      // the projection), then publish to the bus.
      streamed += ae.delta ?? "";
      const sequence = store.write({
        type: "message.sent",
        payload: { messageId: assistantId, role: "assistant", text: ae.delta ?? "", streaming: true, sessionKey },
      });
      emit({ sessionKey, kind: "message.delta", messageId: assistantId, role: "assistant", text: ae.delta ?? "", streaming: true, sequence });
    } else if (ae.type === "text_end" && assistantId) {
      // Turn finished: settle with the final full text (REPLACES the streaming
      // buffer in the projection), publish, then resolve `finished`.
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

  return { finished, unsubscribe };
}
