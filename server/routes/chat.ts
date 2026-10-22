// A conversation socket is a view and command channel; the turn outlives it.
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { createNodeWebSocket, type NodeWebSocket } from "@hono/node-ws";
import type { WSContext } from "hono/ws";
import type { StateStore } from "../stateStore.ts";
import type { PiSessionManager } from "../piSession.ts";
import { recordUserMessage, attachAssistantRelay, type AttachedRelay } from "../relay.ts";
import { AppBus, EVENT, CONTROL, type BusEvent, type ControlEvent } from "../bus.ts";
import { TurnRegistry, type Turn } from "../turnRegistry.ts";
import { authenticate, identity, type AuthOptions, type Identity } from "../auth.ts";
import { Access } from "../access.ts";
import type { ServerFrame } from "../types.ts";

export interface ChatDeps {
  store: StateStore;
  manager: PiSessionManager;
  access: Access;
  bus: AppBus;
  turns: TurnRegistry;
  auth: AuthOptions;
}

export function createChatRouter(deps: ChatDeps): { app: Hono; injectWebSocket: NodeWebSocket["injectWebSocket"] } {
  const { store, manager, access, bus, turns } = deps;
  // Which control events does this socket's user care about? One case per kind.
  const controlEventReaches = (event: ControlEvent, user: Identity): boolean =>
    event.type === "access.changed" ? event.email === user.email :
    event.type === "project.deleted" ? user.isOwner || event.emails.includes(user.email) :
    access.canProject(user, event.projectId);
  const app = new Hono();
  app.onError((err, c) => {
    if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
    console.error("[inbox] request failed", err);
    return c.json({ error: "request failed" }, 500);
  });
  app.use("/api/*", authenticate(deps.auth));
  app.use("/api/*", access.middleware);
  app.get("/api/me", (c) => {
    const { email, isOwner } = identity(c);
    return c.json({ email, isOwner });
  });
  const wsHub = createNodeWebSocket({ app });

  app.get("/api/events", wsHub.upgradeWebSocket((c) => {
    const user = identity(c);
    let handler: ((event: ControlEvent) => void) | undefined;
    let expiry: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      if (handler) bus.off(CONTROL, handler);
      clearTimeout(expiry);
    };
    return {
      onOpen(_event, ws) {
        expiry = setTimeout(() => ws.close(1008, "authentication expired"), Math.min(user.expiresAt - Date.now(), 2147483647));
        handler = (event) => {
          if (controlEventReaches(event, user) && user.expiresAt > Date.now()) {
            // Only identifiers needed to invalidate the recipient's own cache.
            const { type, projectId } = event;
            ws.send(JSON.stringify({ type, projectId,
              ...(event.type === "access.changed" ? { granted: event.granted } : {}),
              ...(event.type === "session.deleted" ? { sessionKey: event.sessionKey } : {}),
            }));
          }
        };
        bus.on(CONTROL, handler);
        ws.send(JSON.stringify({ type: "ready" }));
      },
      onClose: cleanup,
      onError: cleanup,
    };
  }));

  app.get("/api/chat/:key", wsHub.upgradeWebSocket((c) => {
    const key = c.req.param("key")!;
    const projectId = access.session(c, key).projectId;
    const user = identity(c);
    let chatHandler: ((event: BusEvent) => void) | undefined;
    let controlHandler: ((event: ControlEvent) => void) | undefined;
    let expiry: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      if (chatHandler) bus.off(EVENT, chatHandler);
      if (controlHandler) bus.off(CONTROL, controlHandler);
      clearTimeout(expiry);
    };
    const openSocket = (ws: WSContext) => {
      if (!access.canProject(user, projectId) || !store.getSession(key)) {
        ws.close(1008, "not found");
        return;
      }
      const send = (frame: ServerFrame) => ws.send(JSON.stringify(frame));
      expiry = setTimeout(() => ws.close(1008, "authentication expired"), Math.min(user.expiresAt - Date.now(), 2147483647));
      chatHandler = (event) => {
        if (event.sessionKey !== key) return;
        if (!access.canProject(user, projectId) || !store.getSession(key)) {
          ws.close(1008, "not found");
          return;
        }
        if (event.kind === "message.delta") send({ type: "message.delta", messageId: event.messageId, text: event.text });
        else if (event.kind === "message.end") send({ type: "message.end", message: event.message });
        else send({ type: "status", phase: event.phase, errorMessage: event.errorMessage });
      };
      controlHandler = (event) => {
        if (event.projectId === projectId && (!access.canProject(user, projectId) || !store.getSession(key))) {
          cleanup();
          ws.close(1008, "not found");
        }
      };
      // No await between subscription and snapshot: subsequent frames follow it.
      bus.on(EVENT, chatHandler);
      bus.on(CONTROL, controlHandler);
      send({ type: "snapshot", messages: store.getMessages(key), running: turns.has(key) });
    };
    // Runs detached from onMessage so a slow turn never blocks other frames.
    const runTurn = async (turn: Turn, text: string, ws: WSContext) => {
      let relay: AttachedRelay | undefined;
      let phase: "idle" | "aborted" | "error" = "idle";
      let errorMessage: string | undefined;
      try {
        // Open before adding this prompt: restored history must not seed it twice.
        turn.handle = await manager.open(key, store.getProject(projectId)!.dir);
        recordUserMessage(store, bus, key, text, user.email);
        if (access.canProject(user, projectId)) {
          try { ws.send(JSON.stringify({ type: "accepted" } satisfies ServerFrame)); }
          catch { /* A disconnected sender does not stop an accepted turn. */ }
        }
        if (!turn.abortRequested) {
          relay = attachAssistantRelay(store, bus, key, turn.handle.session as Parameters<typeof attachAssistantRelay>[3]);
          await turn.handle.session.prompt(text);
        }
        if (turn.abortRequested) phase = "aborted";
      } catch (err) {
        console.error("[inbox] turn failed", err);
        phase = "error";
        errorMessage = "generation failed";
      } finally {
        try { relay?.unsubscribe(); }
        catch (err) { console.error("[inbox] relay cleanup failed", err); phase = "error"; errorMessage = "could not save response"; }
        turns.delete(key);
        bus.chat({ kind: "status", sessionKey: key, phase, errorMessage });
      }
    };
    return {
      onOpen(_event, ws) { openSocket(ws); },
      onMessage(event, ws) {
        const error = (errorMessage: string) => ws.send(JSON.stringify({ type: "error", errorMessage } satisfies ServerFrame));
        if (!access.canProject(user, projectId) || !store.getSession(key)) {
          ws.close(1008, "not found");
          return;
        }
        let frame: { type?: unknown; text?: unknown };
        try {
          frame = JSON.parse(String(event.data));
          if (!frame || typeof frame !== "object") throw new Error();
        } catch { error("invalid JSON frame"); return; }

        if (frame.type === "abort") {
          const turn = turns.get(key);
          if (turn) {
            turn.abortRequested = true;
            if (turn.handle) void turn.handle.session.abort().catch(() => error("could not stop generation"));
          }
          return;
        }
        if (frame.type !== "prompt") {
          error("unknown frame");
          return;
        }
        if (typeof frame.text !== "string" || !frame.text.trim()) {
          error("prompt text is required");
          return;
        }
        const text = frame.text;
        const turn = turns.start(key);
        if (!turn) {
          error("generation already running");
          return;
        }
        bus.chat({ kind: "status", sessionKey: key, phase: "streaming" });
        void runTurn(turn, text, ws);
      },
      onClose: cleanup,
      onError: cleanup,
    };
  }));
  return { app, injectWebSocket: wsHub.injectWebSocket };
}
