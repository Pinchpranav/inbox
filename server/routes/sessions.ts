// routes/sessions.ts — one conversation: read it, change its state/model/thinking, move it.
// Writes append an event via store.write() and answer { ok: true }; reads come off projections.
//
// ── FLOW ─────────────────────────────────────────────────────────────
//   GET   /api/sessions/:key/messages    store.getMessages(key)
//   GET   /api/sessions/:key/status      turnRegistry.has(key)
//   PATCH /api/sessions/:key/{state,noInbox,model,thinking}
//                                        store.write(session.*)
//   POST  /api/sessions/:key/move        store.write(session.created) under a new key
//   GET   /api/models                    manager.getModels()
//   GET|POST /api/sessions/zdr           manager.getZdr() | setZdr()

import { Hono } from "hono";
import type { StateStore, Session, State } from "../stateStore.ts";
import type { PiSessionManager } from "../piSession.ts";
import type { TurnRegistry } from "../turnRegistry.ts";
import type { Access } from "../access.ts";
import type { AppBus } from "../bus.ts";

const STATES: readonly State[] = ["active", "deferred", "done"];

function isState(v: unknown): v is State {
  return typeof v === "string" && (STATES as readonly string[]).includes(v);
}

/** "agent:<projectId>:<thread>" → projectId. */
function projectIdOfKey(key: string): string {
  return key.split(":")[1] ?? "";
}

/** "agent:<projectId>:<thread>" → thread. */
function threadOfKey(key: string): string {
  const parts = key.split(":");
  return parts.slice(2).join(":");
}

export function createSessionsRouter(store: StateStore, manager: PiSessionManager, access: Access, bus: AppBus, turns: TurnRegistry): Hono {
  const app = new Hono();

  app.get("/api/sessions/:key/messages", (c) => {
    const key = c.req.param("key");
    return c.json(store.getMessages(key));
  });

  // Read-only peek: chat.ts owns the registry.
  app.get("/api/sessions/:key/status", (c) => {
    const key = c.req.param("key");
    return c.json({ sessionKey: key, running: turns.has(key) });
  });

  app.patch("/api/sessions/:key/state", async (c) => {
    const sessionKey = c.req.param("key");
    let body: { state?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ ok: false, error: "invalid JSON body" }, 400);
    }
    if (!isState(body.state)) {
      return c.json({ ok: false, error: "state must be active|deferred|done" }, 400);
    }
    access.write(c, { type: "session.state", payload: { sessionKey, state: body.state } });
    return c.json({ ok: true });
  });

  // Mute only; state is untouched.
  app.patch("/api/sessions/:key/noInbox", async (c) => {
    const sessionKey = c.req.param("key");
    let body: { noInbox?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ ok: false, error: "invalid JSON body" }, 400);
    }
    if (typeof body.noInbox !== "boolean") {
      return c.json({ ok: false, error: "noInbox must be a boolean" }, 400);
    }
    access.write(c, { type: "session.noInbox", payload: { sessionKey, noInbox: body.noInbox } });
    return c.json({ ok: true });
  });

  // {id, name, thinkingLevelMap, input}; no thinkingLevelMap means the model does not reason.
  app.get("/api/models", (c) => {
    return c.json(manager.getModels());
  });

  // Rejected unless the id is one of our curated models.
  app.patch("/api/sessions/:key/model", async (c) => {
    const sessionKey = c.req.param("key");
    let body: { model?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ ok: false, error: "invalid JSON body" }, 400);
    }
    if (typeof body.model !== "string" || !body.model) {
      return c.json({ ok: false, error: "model must be a non-empty string" }, 400);
    }
    if (!manager.getModels().some((m) => m.id === body.model)) {
      return c.json({ ok: false, error: "unknown model id" }, 400);
    }
    access.write(c, { type: "session.model", payload: { sessionKey, modelId: body.model } });
    return c.json({ ok: true });
  });

  app.patch("/api/sessions/:key/thinking", async (c) => {
    const sessionKey = c.req.param("key");
    let body: { level?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ ok: false, error: "invalid JSON body" }, 400);
    }
    if (typeof body.level !== "string" || !body.level) {
      return c.json({ ok: false, error: "level must be a non-empty string" }, 400);
    }
    const valid = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
    if (!valid.includes(body.level)) {
      return c.json({ ok: false, error: "invalid thinking level" }, 400);
    }
    access.write(c, { type: "session.thinking", payload: { sessionKey, level: body.level } });
    return c.json({ ok: true });
  });

  // Moving re-keys: same thread tail under the destination project, so the conversation
  // starts fresh. The old messages stay under the old key.
  app.post("/api/sessions/:key/move", async (c) => {
    const oldKey = c.req.param("key");
    let body: { destProjectId?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ ok: false, error: "invalid JSON body" }, 400);
    }
    const destProjectId = body.destProjectId;
    if (typeof destProjectId !== "string" || !destProjectId) {
      return c.json({ ok: false, error: "destProjectId is required" }, 400);
    }
    const known = store.getProjects().some((p) => p.id === destProjectId);
    if (!known) {
      return c.json({ ok: false, error: "destination project not found" }, 404);
    }
    access.session(c, oldKey);
    access.project(c, destProjectId);

    // Keep the old name.
    const srcProjectId = projectIdOfKey(oldKey);
    const src = store.getSessions(srcProjectId).find((s) => s.key === oldKey);
    const name = src?.name ?? "New conversation";

    const newKey = `agent:${destProjectId}:${threadOfKey(oldKey)}`;
    const session: Session = {
      key: newKey,
      name,
      projectId: destProjectId,
      state: "active",
      noInbox: false,
      lastTouchedAt: null,
    };
    access.write(c, { type: "session.created", payload: { session } });
    return c.json({ ok: true, session: { key: newKey } });
  });

  // Global, not per conversation.
  app.get("/api/sessions/zdr", (c) => c.json({ zdr: manager.getZdr() }));

  // Anything but zdr:true counts as false.
  app.post("/api/sessions/zdr", async (c) => {
    access.owner(c);
    const body = (await c.req.json().catch(() => null)) as { zdr?: boolean } | null;
    await manager.setZdr(body?.zdr === true);
    return c.json({ ok: true });
  });

  app.patch("/api/sessions/:key/name", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (typeof body?.name !== "string" || !body.name.trim()) return c.json({ error: "name is required" }, 400);
    access.write(c, { type: "session.renamed", payload: { sessionKey: c.req.param("key"), name: body.name.trim() } });
    return c.json({ ok: true });
  });

  app.delete("/api/sessions/:key", (c) => {
    const sessionKey = c.req.param("key");
    const session = access.session(c, sessionKey);
    if (turns.has(sessionKey)) return c.json({ error: "stop generation before deleting the conversation" }, 409);
    access.write(c, { type: "session.deleted", payload: { sessionKey } });
    manager.dispose(sessionKey);
    bus.control({ type: "session.deleted", projectId: session.projectId, sessionKey });
    return c.json({ ok: true });
  });

  return app;
}
