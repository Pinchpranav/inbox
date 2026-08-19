// server/index.ts — entry: build the store + session manager, mount all four routers,
// serve HTTP + WS, keep the process alive, and shut down gracefully. (build-5ei)
//
// ── FLOW (assembly line) ─────────────────────────────────────────────
//   main() -> StateStore(dbPath) + rebuildProjections()
//           -> PiSessionManager.create(store, { agentDir, cwd })   (async)
//           -> buildApp({ store, manager }) -> { app, injectWebSocket }
//           -> serve({ fetch: app.fetch, port })                   (HTTP)
//           -> injectWebSocket(server)                             (WS, AFTER serve)
//   Graceful shutdown (SIGINT/SIGTERM): manager.disposeAll() -> store.close()
//
// Note the ordering contract from routes/chat.ts: createChatRouter returns
// { app, injectWebSocket }, and injectWebSocket(server) MUST be called after serve().
// We mount the REST routers + /api/health onto the same Hono `app` that the chat
// router built, so the node-ws upgrade handler is registered on the exact app
// instance that gets served.

import { join, dirname } from "node:path";
import { mkdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { serve, type ServerType } from "@hono/node-server";
import { Hono } from "hono";
import { StateStore } from "./stateStore.ts";
import { PiSessionManager } from "./piSession.ts";
import { createProjectsRouter } from "./routes/projects.ts";
import { createSessionsRouter } from "./routes/sessions.ts";
import { createInboxRouter } from "./routes/inbox.ts";
import { createChatRouter } from "./routes/chat.ts";

/** Everything buildApp needs. Both are created by main() (store sync, manager async). */
export interface AppDeps {
  store: StateStore;
  manager: PiSessionManager;
}

/**
 * Build the Hono app: mount /api/projects, /api/sessions, /api/inbox, /api/chat and
 * /api/health. Returns the app plus the WS injector (from the chat router), which the
 * caller MUST invoke after serve().
 */
export function buildApp(deps: AppDeps): { app: Hono; injectWebSocket: (server: ServerType) => void } {
  const { store, manager } = deps;

  /** Resolve a session key ("agent:<projectId>:<thread>") to its project working dir. */
  const projectDirFor = (sessionKey: string): string => {
    const projectId = sessionKey.split(":")[1] ?? "";
    const project = store.getProjects().find((p) => p.id === projectId);
    return project?.dir ?? process.cwd();
  };

  // Build the chat router first — its `app` carries the node-ws upgrade handler, so we
  // keep THAT instance as the root app and mount the REST routers onto it.
  const { app, injectWebSocket } = createChatRouter({ store, manager, projectDirFor });

  app.get("/api/health", (c) => c.json({ ok: true }));

  app.route("/", createProjectsRouter(store));
  app.route("/", createSessionsRouter(store));
  app.route("/", createInboxRouter(store));

  return { app, injectWebSocket };
}

export interface MainDeps {
  dbPath: string;
  agentDir: string;
  cwd: string;
  port?: number;
}

/**
 * Full assembly: open the store, rebuild projections, create the manager, build the app,
 * serve HTTP + WS, and install graceful-shutdown handlers. Returns handles for tests.
 */
export async function main(deps: MainDeps): Promise<{ app: Hono; store: StateStore; manager: PiSessionManager; server: ServerType }> {
  // The sqlite file lives in a subdir (default .inbox/) that node:sqlite will
  // NOT create for us — on a fresh clone it doesn't exist and DatabaseSync
  // throws. Create it so the backend can boot anywhere. (dbPath is always set
  // here: main() is called with deps.dbPath from the isMain block or a test.)
  mkdirSync(dirname(deps.dbPath), { recursive: true });

  const store = new StateStore(deps.dbPath);
  store.rebuildProjections();

  const manager = await PiSessionManager.create(store, {
    agentDir: deps.agentDir,
    cwd: deps.cwd,
  });

  const { app, injectWebSocket } = buildApp({ store, manager });
  const port = deps.port ?? 8787;

  const server = serve({ fetch: app.fetch, port });
  injectWebSocket(server); // attach WS AFTER serve — required by @hono/node-ws
  console.log(`[inbox] listening on http://localhost:${port} (WS + HTTP)`);

  const shutdown = () => {
    console.log("[inbox] shutting down...");
    server.close(); // stop accepting new connections
    manager.disposeAll(); // close every open AgentSession
    store.close(); // close the SQLite store
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  return { app, store, manager, server };
}

/** Run directly: `npx tsx server/index.ts` (or `node server/index.ts` after a build). */
const isMain =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === fileURLToPath(pathToFileURL(process.argv[1]).href);

if (isMain) {
  const cwd = process.cwd();
  main({
    dbPath: process.env.INBOX_DB ?? join(cwd, ".inbox", "inbox.db"),
    agentDir: process.env.INBOX_AGENT_DIR ?? cwd,
    cwd,
    port: process.env.PORT ? Number(process.env.PORT) : 8787,
  }).catch((err) => {
    console.error("[inbox] fatal startup error:", err);
    process.exit(1);
  });
}
