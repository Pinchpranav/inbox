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
import { recordUserMessage, attachAssistantRelay } from "../relay.ts";
import { bus, EVENT, type BusEvent } from "../bus.ts";
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
      let busy = false; // guard: one turn at a time per connection
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
            const text = frame.text; // narrowed here (inside the async closure TS resets it)
            void (async () => {
              if (busy) {
                wsc.send(JSON.stringify({ type: "status", sessionKey, phase: "error" }));
                return;
              }
              busy = true;
              try {
                // ① persist user msg (NOT forwarded to browser — it already rendered it)
                recordUserMessage(store, sessionKey, text);
                // ② open or resume the conversation's AgentSession
                const handle = await manager.open(sessionKey, projectDirFor(sessionKey));
                currentHandle = handle;
                // ③ attach the relay: persists + publishes each assistant delta/end
                // piSession types subscribe as `(ev: unknown)` while the relay (proven) expects
                // `PiEvent`; both are proven files, so we adapt at the seam with a cast.
                const relay = attachAssistantRelay(
                  store,
                  sessionKey,
                  handle.session as Parameters<typeof attachAssistantRelay>[2],
                );
                // ④ run the engine (fires the relay's subscribe callback)
                await handle.session.prompt(text);
                // ⑤ wait for text_end, then report idle
                await relay.finished;
                wsc.send(JSON.stringify({ type: "status", sessionKey, phase: "idle" }));
              } catch (err) {
                wsc.send(JSON.stringify({ type: "error", sessionKey, errorMessage: String(err) }));
              } finally {
                busy = false;
              }
            })();
          } else if (frame.type === "abort") {
            void (async () => {
              try {
                if (currentHandle) await currentHandle.session.abort();
                wsc.send(JSON.stringify({ type: "status", sessionKey, phase: "aborted" }));
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
