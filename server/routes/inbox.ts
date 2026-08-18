// routes/inbox.ts — the inbox rail (contracts Flow A). Thin wrapper over the store's inbox
// query. getInbox() already returns only sessions that are active AND not muted, so every
// row already satisfies the InboxSession subset — we just reshape it to the wire type.
//
// ── FLOW ─────────────────────────────────────────────────────────────
//   GET /api/inbox → getInbox() (active + ≤48h + noInbox=0, all projects) → InboxSession[]

import { Hono } from "hono";
import type { StateStore } from "../stateStore.ts";
import type { InboxSession } from "../types.ts";

export function createInboxRouter(store: StateStore): Hono {
  const app = new Hono();

  // GET /api/inbox — active + not muted + touched within the window (default 48h).
  app.get("/api/inbox", (c) => {
    const sessions = store.getInbox();
    const inbox: InboxSession[] = sessions.map((s) => ({
      key: s.key,
      name: s.name,
      projectId: s.projectId,
      state: "active", // getInbox() guarantees active
      noInbox: false, // getInbox() guarantees not muted
      lastTouchedAt: s.lastTouchedAt,
    }));
    return c.json(inbox);
  });

  return app;
}
