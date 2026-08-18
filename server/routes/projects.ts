// routes/projects.ts — projects + their sessions (contracts Flow A reads, Flow B2 + E writes).
// Each write appends a domain event via store.write() (append + project + checkpoint) then
// returns { ok: true }. POST /api/projects also scaffolds the identity .md files at `dir`
// (system §10). Dolt/Beads scope seeding is a later phase.
//
// ── FLOW ─────────────────────────────────────────────────────────────
//   GET   /api/projects                → getProjects()                 (Project[])
//   POST  /api/projects                → write(project.created) + scaffold .md → { ok, project:{id} }
//   PATCH /api/projects/:id/state      → write(project.state)          → { ok:true }
//   GET   /api/projects/:id/sessions   → getSessions(id)               (Session[])
//   POST  /api/projects/:id/sessions   → write(session.created)        → { ok, session:{key} }

import { Hono } from "hono";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { StateStore, Project, Session, State } from "../stateStore.ts";

const STATES: readonly State[] = ["active", "deferred", "done"];

function isState(v: unknown): v is State {
  return typeof v === "string" && (STATES as readonly string[]).includes(v);
}

/** URL-safe slug from a name; falls back to "conversation". Used for the thread part of a key. */
function slugify(s: string): string {
  const slug = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug || "conversation";
}

/** Short random suffix so two same-named threads stay distinct. */
function shortId(): string {
  return randomUUID().split("-")[0];
}

/** A session key is "agent:<projectId>:<thread>". Builds the thread from name (or uuid if blank). */
function newSessionKey(projectId: string, name?: string): string {
  const thread = name?.trim() ? `${slugify(name)}-${shortId()}` : shortId();
  return `agent:${projectId}:${thread}`;
}

/** Minimal identity files scaffolded at a project's working dir on creation (system §10). */
function scaffoldIdentityFiles(dir: string) {
  mkdirSync(dir, { recursive: true });
  const files: Array<[string, string]> = [
    [
      "AGENTS.md",
      `# AGENTS.md — operating rules\n\nRules the agent follows when working in this project. Read the\nidentity files (SOUL.md / IDENTITY.md / USER.md) lazily when you need them.\n`,
    ],
    [
      "SOUL.md",
      `# SOUL.md — personality\n\nThe working style and tone of this project's agent. Filled in by the owner.\n`,
    ],
    [
      "IDENTITY.md",
      `# IDENTITY.md — factual identity\n\nWho this agent is / what this project is. Filled in by the owner.\n`,
    ],
    [
      "USER.md",
      `# USER.md — facts about the user\n\nWhat the agent should know about its operator. Filled in by the owner.\n`,
    ],
  ];
  for (const [file, content] of files) {
    writeFileSync(join(dir, file), content, "utf8");
  }
}

export function createProjectsRouter(store: StateStore): Hono {
  const app = new Hono();

  // GET /api/projects — all projects.
  app.get("/api/projects", (c) => {
    return c.json(store.getProjects());
  });

  // POST /api/projects — create a project + scaffold its identity .md files.
  app.post("/api/projects", async (c) => {
    let body: { name?: string; dir?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ ok: false, error: "invalid JSON body" }, 400);
    }
    const name = body.name?.trim();
    const dir = body.dir?.trim();
    if (!name || !dir) {
      return c.json({ ok: false, error: "name and dir are required" }, 400);
    }
    const now = Date.now();
    const project: Project = {
      id: randomUUID(),
      name,
      dir,
      state: "active",
      createdAt: now,
      updatedAt: now,
    };
    try {
      scaffoldIdentityFiles(dir);
    } catch {
      return c.json({ ok: false, error: "could not scaffold project dir" }, 500);
    }
    store.write({ type: "project.created", payload: { project } });
    return c.json({ ok: true, project: { id: project.id } });
  });

  // PATCH /api/projects/:id/state — move a project through active/deferred/done.
  app.patch("/api/projects/:id/state", async (c) => {
    const projectId = c.req.param("id");
    let body: { state?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ ok: false, error: "invalid JSON body" }, 400);
    }
    if (!isState(body.state)) {
      return c.json({ ok: false, error: "state must be active|deferred|done" }, 400);
    }
    store.write({ type: "project.state", payload: { projectId, state: body.state } });
    return c.json({ ok: true });
  });

  // GET /api/projects/:id/sessions — a project's conversations.
  app.get("/api/projects/:id/sessions", (c) => {
    const projectId = c.req.param("id");
    return c.json(store.getSessions(projectId));
  });

  // POST /api/projects/:id/sessions — open a new conversation in a project.
  app.post("/api/projects/:id/sessions", async (c) => {
    const projectId = c.req.param("id");
    const known = store.getProjects().some((p) => p.id === projectId);
    if (!known) {
      return c.json({ ok: false, error: "project not found" }, 404);
    }
    let name: string | undefined;
    try {
      const body = (await c.req.json()) as { name?: string };
      name = body.name?.trim();
    } catch {
      /* empty body is fine — session gets a default name */
    }
    const key = newSessionKey(projectId, name);
    const session: Session = {
      key,
      name: name || "New conversation",
      projectId,
      state: "active",
      noInbox: false,
      lastTouchedAt: null,
    };
    store.write({ type: "session.created", payload: { session } });
    return c.json({ ok: true, session: { key } });
  });

  return app;
}
