// routes/chat.ts — the WebSocket streaming channel (contracts Flow C/D).
// This is where the proven pieces get wired together on every prompt:
//   persist user msg -> open/resume the AgentSession -> attach the relay ->
//   run the engine -> the relay persists + publishes to the bus -> this route
//   forwards frames to the browser.
//
// Ordering rule (contracts Flow C): every event is persisted (awaited) BEFORE it
// is published to the bus. The bus carries assistant output; the user's own
// message is persisted but its message.sent is NOT forwarded (the browser
// already rendered it).
//
// Per-turn lifecycle (review fixes):
//   - The PROMPT handler owns the single terminal status frame. It waits on
//     `session.prompt()` (NOT `relay.finished`), so it can't hang when a turn
//     ends without a text_end (empty / aborted / silent-error). It reports
//     "idle" normally, "aborted" if abortRequested was set.
//   - ABORT only interrupts the engine (`session.abort()`) + sets the
//     abortRequested flag; it never emits a terminal frame, so prompt and abort
//     can't race to contradictory states.
//   - Each relay is unsubscribed in `finally` (it lives for exactly one turn) —
//     otherwise listeners leak on the reused per-key AgentSession and a stale
//     relay double-persists/publishes on later turns.
//
// ── FLOW (who calls what) ─────────────────────────────────────────────
//   index.ts (entry, build-5ei):
//     const { app, injectWebSocket } = createChatRouter(deps)
//     const server = serve({ fetch: app.fetch, port })
//     injectWebSocket(server)          // attaches the WS server to the HTTP server
//   Browser ──ClientFrame──▶ WS /api/chat/:key ──▶ this route
//   this route ──ServerFrame──▶ Browser
//
// NOTE: this factory returns `{ app, injectWebSocket }` (not just `Hono`) because
// @hono/node-ws needs injectWebSocket(server) called AFTER serve() in index.ts.

import { Hono } from "hono";
import { createNodeWebSocket, type NodeWebSocket } from "@hono/node-ws";
import type { StateStore, Message } from "../stateStore.ts";
import type { PiSessionManager, SessionHandle } from "../piSession.ts";
import { recordUserMessage, attachAssistantRelay, type AttachedRelay } from "../relay.ts";
import { bus, EVENT, type BusEvent } from "../bus.ts";
import { turnRegistry } from "../turnRegistry.ts";
import type { ClientFrame } from "../types.ts";

/** Everything the chat route needs, injected by index.ts (build-5ei). */
export interface ChatDeps {
  store: StateStore;
  manager: PiSessionManager;
  /** Resolve a session key ("agent:<projectId>:<thread>") to its project working dir. */
  projectDirFor: (sessionKey: string) => string;
}

/** Normalize a WS message payload (string | Blob | ArrayBuffer | Buffer) to text. */
function dataToString(data: unknown): string {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  }
  return String(data);
}

export function createChatRouter(deps: ChatDeps): { app: Hono; injectWebSocket: NodeWebSocket["injectWebSocket"] } {
  const { store, manager, projectDirFor } = deps;
  const app = new Hono();
  const wsHub = createNodeWebSocket({ app });

  app.get(
    "/api/chat/:key",
    wsHub.upgradeWebSocket((c) => {
      // "key" is guaranteed by the route path /api/chat/:key, so it's never undefined.
      const sessionKey = c.req.param("key") as string;
      // Per-connection state:
      let currentHandle: SessionHandle | undefined; // the open AgentSession, for abort
      let abortRequested = false; // set by the abort handler; read by the prompt handler (which owns the terminal frame)
      let busHandler: ((ev: BusEvent) => void) | null = null; // for cleanup via bus.off

      return {
        onOpen(_evt, wsc) {
          // Forward the durable write -> browser. Bus carries assistant delta/end only.
          busHandler = (ev: BusEvent) => {
            if (ev.sessionKey !== sessionKey) return; // only this conversation
            if (ev.kind === "message.delta") {
              wsc.send(JSON.stringify({ type: "message.delta", sessionKey, messageId: ev.messageId, text: ev.text }));
            } else if (ev.kind === "message.end") {
              // The final message is already in the store (persist-before-publish).
              const message =
                store.getMessages(ev.sessionKey).find((m) => m.id === ev.messageId) ??
                ({
                  id: ev.messageId,
                  sessionKey: ev.sessionKey,
                  role: ev.role,
                  text: ev.text,
                  isStreaming: false,
                  timestamp: Date.now(),
                  idx: 0,
                } as Message);
              wsc.send(JSON.stringify({ type: "message.end", sessionKey, message }));
            }
            // kind "message.sent" (user prompt) is intentionally NOT forwarded.
          };
          bus.on(EVENT, busHandler);
        },

        onMessage(_evt, wsc) {
          let frame: ClientFrame;
          try {
            frame = JSON.parse(dataToString(_evt.data)) as ClientFrame;
          } catch {
            wsc.send(JSON.stringify({ type: "error", sessionKey, errorMessage: "invalid JSON frame" }));
            return;
          }

          if (frame.type === "prompt") {
            // Validate the prompt text before persisting (a non-string would write a NULL row).
            if (typeof frame.text !== "string" || !frame.text.trim()) {
              wsc.send(JSON.stringify({ type: "error", sessionKey, errorMessage: "prompt text is required" }));
              return;
            }
            const text = frame.text; // narrowed here (inside the async closure TS resets it)
            void (async () => {
              // One turn at a time PER CONVERSATION (not per connection): a second
              // prompt on the same key would interleave inside one AgentSession.
              if (turnRegistry.has(sessionKey)) {
                wsc.send(JSON.stringify({ type: "status", sessionKey, phase: "error" }));
                return;
              }
              turnRegistry.add(sessionKey);
              abortRequested = false;
              // The relay is scoped here so its `finally` unsubscribe always runs (stale-relay fix).
              let relay: AttachedRelay | null = null;
              try {
                // ① persist user msg (NOT forwarded to browser — it already rendered it)
                recordUserMessage(store, sessionKey, text);
                // ② open or resume the conversation's AgentSession
                const handle = await manager.open(sessionKey, projectDirFor(sessionKey));
                currentHandle = handle;
                // ③ attach the relay: persists + publishes each assistant delta/end
                // piSession types subscribe as `(ev: unknown)` while the relay (proven) expects
                // `PiEvent`; both are proven files, so we adapt at the seam with a cast.
                relay = attachAssistantRelay(
                  store,
                  sessionKey,
                  handle.session as Parameters<typeof attachAssistantRelay>[2],
                );
                // ④ run the engine (fires the relay's subscribe callback). Awaiting the prompt
                // resolves when the turn is done — this, NOT `relay.finished`, is the terminal
                // signal, so we can't hang if no text_end fires (empty/aborted/silent-error turn).
                await handle.session.prompt(text);
                // ⑤ the prompt handler owns the single terminal frame (no race with abort).
                if (abortRequested) {
                  wsc.send(JSON.stringify({ type: "status", sessionKey, phase: "aborted" }));
                } else {
                  wsc.send(JSON.stringify({ type: "status", sessionKey, phase: "idle" }));
                }
              } catch (err) {
                wsc.send(JSON.stringify({ type: "error", sessionKey, errorMessage: String(err) }));
              } finally {
                relay?.unsubscribe(); // detach this turn's relay from the shared AgentSession (stale-relay fix)
                turnRegistry.delete(sessionKey); // the turn is over (idle/aborted/error all pass through here)
              }
            })();
          } else if (frame.type === "abort") {
            void (async () => {
              // Abort only interrupts the engine + sets the flag; the prompt handler owns the
              // terminal frame, so we never get a second conflicting status here.
              abortRequested = true;
              try {
                if (currentHandle) await currentHandle.session.abort();
              } catch (err) {
                wsc.send(JSON.stringify({ type: "error", sessionKey, errorMessage: String(err) }));
              }
            })();
          }
        },

        onClose() {
          if (busHandler) bus.off(EVENT, busHandler);
          busHandler = null;
          currentHandle = undefined;
        },
        onError() {
          if (busHandler) bus.off(EVENT, busHandler);
          busHandler = null;
          currentHandle = undefined;
        },
      };
    }),
  );

  return { app, injectWebSocket: wsHub.injectWebSocket };
}
