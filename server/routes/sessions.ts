// routes/sessions.ts — a single conversation (contracts Flow B1 read, Flow E writes).
// Reads come off the projections; each write appends a domain event via store.write()
// then returns { ok: true }. A move keeps the transcript (old messages stay under the old
// key) but resets memory (a fresh key = a fresh thread identity).
//
// ── FLOW ─────────────────────────────────────────────────────────────
//   GET   /api/sessions/:key/messages   → getMessages(key)    (Message[], history, not live)
//   PATCH /api/sessions/:key/state      → write(session.state)       → { ok:true }
//   PATCH /api/sessions/:key/noInbox    → write(session.noInbox)     → { ok:true }
//   POST  /api/sessions/:key/move       → write(session.created) w/ new key → { ok, session:{key} }

import { Hono } from "hono";
import type { StateStore, Session, State } from "../stateStore.ts";
import type { PiSessionManager } from "../piSession.ts";

const STATES: readonly State[] = ["active", "deferred", "done"];

function isState(v: unknown): v is State {
  return typeof v === "string" && (STATES as readonly string[]).includes(v);
}

/** Pull the <projectId> out of a key ("agent:<projectId>:<thread>..."). */
function projectIdOfKey(key: string): string {
  return key.split(":")[1] ?? "";
}

/** Pull the <thread> tail out of a key (the part after "agent:<projectId>:"). */
function threadOfKey(key: string): string {
  const parts = key.split(":");
  return parts.slice(2).join(":");
}

export function createSessionsRouter(store: StateStore, manager: PiSessionManager): Hono {
  const app = new Hono();

  // GET /api/sessions/:key/messages — reload transcript (not the live stream).
  app.get("/api/sessions/:key/messages", (c) => {
    const key = c.req.param("key");
    return c.json(store.getMessages(key));
  });

  // PATCH /api/sessions/:key/state — move a conversation through active/deferred/done.
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
    store.write({ type: "session.state", payload: { sessionKey, state: body.state } });
    return c.json({ ok: true });
  });

  // PATCH /api/sessions/:key/noInbox — mute/unmute a conversation (no state change).
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
    store.write({ type: "session.noInbox", payload: { sessionKey, noInbox: body.noInbox } });
    return c.json({ ok: true });
  });

  // POST /api/sessions/:key/move — re-home a conversation under a new project.
  // Transcript kept (old messages stay under the old key); memory resets (new key/thread).
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

    // Find the source session (by key within its own project) so we keep its name.
    const srcProjectId = projectIdOfKey(oldKey);
    const src = store.getSessions(srcProjectId).find((s) => s.key === oldKey);
    const name = src?.name ?? "New conversation";

    // New key = same thread tail under the destination project → fresh identity.
    const newKey = `agent:${destProjectId}:${threadOfKey(oldKey)}`;
    const session: Session = {
      key: newKey,
      name,
      projectId: destProjectId,
      state: "active",
      noInbox: false,
      lastTouchedAt: null,
    };
    store.write({ type: "session.created", payload: { session } });
    return c.json({ ok: true, session: { key: newKey } });
  });

  // POST /api/sessions/zdr — global ZDR toggle (x-cmd-zdr: 1 on every request).
  // No validation beyond the boolean: the UI is the only caller.
  app.post("/api/sessions/zdr", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { zdr?: unknown } | null;
    await manager.setZdr(body?.zdr === true);
    return c.json({ ok: true });
  });

  return app;
}
