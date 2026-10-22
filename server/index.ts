// server/index.ts — where the backend starts.
//
//   buildApp()  assembles the HTTP + WebSocket app but opens no port.
//   main()      starts the database, the agent manager and the HTTP server,
//               then cleans everything up on shutdown.
//
// Ordering rules this file exists to enforce:
//   1. the database is caught up before anything is served
//   2. the chat router is built first — it owns the WebSocket handling
//   3. WebSockets are attached only after the server is listening

import { join, dirname } from "node:path";
import { mkdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { serve, type ServerType } from "@hono/node-server";
import { Hono } from "hono";
import { StateStore } from "./stateStore.ts";
import { PiSessionManager } from "./piSession.ts";
import { resolvePiExtensions } from "./piExtensions.ts";
import { createProjectsRouter } from "./routes/projects.ts";
import { createSessionsRouter } from "./routes/sessions.ts";
import { createInboxRouter } from "./routes/inbox.ts";
import { createChatRouter } from "./routes/chat.ts";
import { Access } from "./access.ts";
import { AppBus } from "./bus.ts";
import { TurnRegistry } from "./turnRegistry.ts";
import type { AuthOptions } from "./auth.ts";

/** The pieces buildApp() needs. */
export interface AppDeps {
  store: StateStore;
  manager: PiSessionManager;
  auth?: AuthOptions;
}

/**
 * Assemble the app: create the shared helpers and mount every route.
 * Returns the app plus a function that attaches WebSockets — call it after
 * the HTTP server is listening.
 */
export function buildApp(deps: AppDeps): { app: Hono; injectWebSocket: (server: ServerType) => void } {
  const { store, manager } = deps;
  const access = new Access(store); // who is allowed to touch what
  const bus = new AppBus(); // pushes live updates to connected sockets
  const turns = new TurnRegistry(); // at most one running turn per conversation

  // The chat router builds the app and owns the WebSocket upgrade handling, so it
  // goes first and the other routers are mounted onto its app. Auth settings come
  // from the environment; tests can pass their own.
  const auth = deps.auth ?? {
    ownerEmail: process.env.INBOX_OWNER_EMAIL,
    teamDomain: process.env.CF_ACCESS_TEAM_DOMAIN,
    audience: process.env.CF_ACCESS_AUD,
    publicOrigin: process.env.INBOX_PUBLIC_ORIGIN,
    devEmail: process.env.INBOX_DEV_EMAIL,
  };
  const { app, injectWebSocket } = createChatRouter({ store, manager, access, bus, turns, auth });

  app.route("/", createProjectsRouter(store, access, bus, turns, manager));
  app.route("/", createSessionsRouter(store, manager, access, bus, turns));
  app.route("/", createInboxRouter(store, access));

  return { app, injectWebSocket };
}

export interface MainDeps {
  dbPath: string; // SQLite file (created on first run)
  agentDir: string; // pi's config directory
  cwd: string; // default working directory for agents
  port?: number; // defaults to 8787
}

/**
 * Start the backend: open the database, create the agent manager, serve HTTP +
 * WebSockets, and shut down cleanly. Returns its handles (handy for tests).
 */
export async function main(deps: MainDeps): Promise<{ app: Hono; store: StateStore; manager: PiSessionManager; server: ServerType }> {
  // The default database lives in .inbox/, which may not exist yet — create it.
  mkdirSync(dirname(deps.dbPath), { recursive: true });

  const store = new StateStore(deps.dbPath);
  store.rebuildProjections(); // catch the read tables up with the event log after a restart

  // Optional pi extensions (e.g. browser tools) loaded into every agent session.
  const extensions = resolvePiExtensions();

  const manager = await PiSessionManager.create(store, {
    agentDir: deps.agentDir,
    cwd: deps.cwd,
    extensions,
  });

  const { app, injectWebSocket } = buildApp({ store, manager });
  const port = deps.port ?? 8787;

  // Loopback only: from outside, nginx/cloudflared proxies to this port.
  const server = serve({ fetch: app.fetch, port, hostname: "127.0.0.1" });
  injectWebSocket(server); // must run after serve()
  console.log(`[inbox] listening on http://localhost:${port} (WS + HTTP)`);

  const shutdown = () => {
    console.log("[inbox] shutting down...");
    server.close(); // stop accepting connections
    manager.disposeAll(); // close every open agent session
    store.close(); // close the database
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  return { app, store, manager, server };
}

/** Run directly: `npx tsx server/index.ts` (or `node server/index.ts` after a build). */
const isMain = // true when this file was launched, false when a test only imports it
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
