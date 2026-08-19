# Pi-Powered Sidebar Agent — System Design (System / Contracts Layer)

**Status:** DRAFT v2 (2026-08-11). Written against the LOCKED `functionality_v4.md` behavior contract, revised per review.
**Purpose:** Pin the **how** — architecture, components, data flow, and MVP file structure. Mechanism names (sqlite, dolt/Beads, Hono, pi AgentSession) that v4 deliberately left out are made concrete here.
**Predecessor:** `functionality_v4.md` (behavior, locked). **Next:** `contracts.md` (data shapes) then `step2-files.md` (signatures).
**Author:** Pi (assistant), for Pranav. Review + sign off before scaffolding.

---

## 0. The one-sentence system

**A Hono Node backend keeps the process alive 24/7 (herdr/systemd), owns all app state in a versioned sqlite store (t3code event-sourcing + projections), holds one in-process pi `AgentSession` per conversation (the stateless brain), bridges UI↔pi↔state over HTTP+WebSocket, stores per-project memory in one shared dolt/Beads database, and spawns specialist subagents on demand** — with the existing Vue sidebar UI kept and rewired to replace the OpenClaw gateway transport.

Everything in v4 (projects=own agents, inbox, two-level state, durable conversations, memory, crons, subagents, identity files) is a **view/mechanism over this one backend + pi + sqlite + dolt**, with **no parallel source of truth**.

---

## 1. Architecture — one round trip, not a one-way pipe

The request travels **down** to the engine and the result travels **back up** through the same bridge. Nothing is fire-and-forget; every hop has a return path.

```
  User in browser (existing Vue UI — kept)
      │ ① sends prompt  →  WS /api/chat/:id  { type:"prompt", text }
      ▼
   ┌───────────────  Hono backend (server/, TS, Node)  ───────────────┐
   │  SessionManager — one pi AgentSession per conversation (in-proc)  │
   │  relay.ts       — streams events from browser and logs to sqlite    │
   │  stateStore.ts  — sqlite: orchestration_events + projection_*     │
   │  scheduler/     — cron worker (headless pi runs)                  │
   │  routes/        — /api/projects, /api/sessions, /api/chat, ...    │
   └───────────────┬───────────────────────────────────────────────────┘
                   │ ② forwards prompt to the conversation's AgentSession
                   ▼
        pi engine — reads/edits files in cwd, spawns subagents (5 tools),
            calls memory if needed (bd CLI) — works across tools/memory
                   │
	               |③ streams events back (text_delta, message_end, tool_call)
                   ▼
   relay.ts → ④ pushes live frames to browser (resolveDeltaChatStreamText)
            → ⑤ appends the SAME events to sqlite orchestration log (durable)
                    │
                    ▼
   browser renders live text; projections in sqlite/dolt stay current
```

**The intent:** browser → Hono → pi → (tools / subagents / memory) → back up through relay → browser, with **every durable fact logged to sqlite** on the way. The arrow points down and then back up — it's a loop.

---

## 2. The engine layer: pi `AgentSession` (in-process, not subprocess)

### 2.1 Vocabulary (clearing up the confusion)
- **`ModelRuntime`** — the object that holds the **model/provider configuration**. It answers "**which** model and **how** do I call it." One `ModelRuntime` serves all conversations. It is *not* "the model" — it's the config object that knows the model.

**⚠️ Spike finding (2026-08-13, VPS):** `ModelRuntime.create()` in-process does **NOT** auto-load extensions the way the CLI does. `ollama-cloud` is an **extension provider** (via the `pi-ollama-cloud` package), not a builtin — so `ModelRuntime.create()` alone silently falls back to whatever builtin provider exists (e.g. `opencode-go` → 401 insufficient balance). The backend **must explicitly register the provider** from the installed `pi-ollama-cloud` package **before** `createAgentSession`:
```ts
import { createOllamaCloudProvider } from "pi-ollama-cloud";   // exact export TBD
modelRuntime.registerProvider("ollama-cloud", await createOllamaCloudProvider());
// then createAgentSession({ modelRuntime, model: "ollama-cloud/<id>", ... })
```
Ordering constraint: **model selection happens before extensions bind**, so registration must precede session creation, and an explicit `model` is safest. (The extension's web tools are only needed later for the web-search subagent, not the main agent.)

**Corrected API facts:** `ModelRuntime` has **no `.provider` property**; session messages store **`content[]` parts, not `.text`** — extract text via the content array. Main agent built-in tool names: `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls` (we allowlist `read write edit bash subagent`).
- **Switching models at runtime:** ModelRuntime just *resolves* the config; switching a conversation's model is a **runtime session op**, not a ModelRuntime rebuild — `session.setModel(model)` / `session.cycleModel()` (SDK), plus `setThinkingLevel()`. pi also ships a model-switching / preset extension (`preset.ts` — model/tools/thinking presets). In our backend we expose `POST /api/sessions/:id/model` → `session.setModel()`, so you can switch per conversation without touching ModelRuntime.
- **`AgentSession`** — per the pi SDK docs: *"The session manages agent lifecycle, message history, model state, compaction, and event streaming."* It is a **single conversation's engine instance** — its own context, message history, tools, and streaming. One conversation = one `AgentSession`.
- **"The stateless engine"** — pi (the `AgentSession` runtime). It's *stateless* in the sense that it owns **no durable store of its own**; every durable fact lives in our sqlite. If pi restarts, we rebuild the session from the log.

### 2.2 The session in code (idea)

```ts
import { createAgentSession, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";

const modelRuntime = await ModelRuntime.create();   // reads ~/.pi/agent → ollama-cloud + defaultModel
const { session } = await createAgentSession({
  modelRuntime,
  sessionManager: SessionManager.inMemory(),        // we own durability via sqlite, not pi
  cwd: projectDir,                                  // execution anchored to the project dir
  tools: ["read", "write", "edit", "bash", "subagent"],   // main agent: exactly these 5
});
session.subscribe((ev) => relay.handle(sessionId, ev));   // → WS (live) + sqlite log (durable)
await session.prompt(userText);                           // resolve after the run finishes
// NO steer — the user steers by abort + re-prompt.
// session.abort() on request.
```

**Tools — main agent only (locked):** `read`, `write`, `edit`, `bash`, `subagent`. No grep/find/ls on main. Web search, web fetch, memory, etc. live on **specialist subagents**, not the main agent.

**SDK vs RPC subprocess:** the SDK docs explicitly recommend `AgentSession` in-process for Node apps; it gives native multi-conversation concurrency (each conversation = one session object) and full tool control (`agent.state.tools`). `pi --mode rpc` (JSONL subprocess) is the fallback for process isolation; the relay maps the same events either way.

**Governing philosophy — lazy loading (v4 §0, §3.2, §9):** the agent is *told* what exists (projects, memory keys, specialist subagents) via AGENTS.md / system prompt, and *loads* files/memory only when it judges it necessary. We never pre-load an entire project's context.

---

## 3. State store: sqlite (t3code event-sourcing + projections)

### 3.1 `orchestration_events` — append-only log (the source of truth)
Every event is appended once, in order: prompt accepted, text_delta chunk, tool_call started/finished, message_end, aborted, error. This is the durability backstop — pi is stateless, so this is what we rebuild from after a restart.

### 3.2 `projection_*` — denormalized read models rebuilt from the log
Rebuilt via upserts on each write so UI reads are cheap:
- `projection_projects` — id, name, emoji, working dir, state, created/updated.
- `projection_sessions` — key (`agent:<projectId>:<thread>`), name, projectId, state, `noInbox`, `lastTouchedAt`.
- `projection_messages` — sessionKey, role, text, timestamp, index.
- `projection_threads` — per-conversation ordering + status (streaming/idle/aborted).

**Project + conversation state lives in sqlite** (the `noInbox` flag, two-level state, last-touched — these power the inbox filter).

### 3.3 How t3code does it: persist-first, then stream from an in-memory bus (answering the relay question)
A subagent traced t3code's actual code. Verdict: **persist first (awaited), then stream from an in-memory event bus — NOT from the projections table.** The projections are for history/reload, not live streaming.

Per assistant text delta:
1. Provider emits a delta → `ProviderRuntimeIngestion` dispatches a command.
2. Decider turns it into a `thread.message-sent` event (`streaming: true`, `text = delta`).
3. **DB write (awaited):** one SQL transaction appends to `orchestration_events` **and** upserts the projections (the message projection concatenates the delta onto the running text). Must commit before anything else.
4. **Publish (after commit):** the same event is published to an in-memory Effect `PubSub`.
5. **Client push:** the WS layer subscribes to that PubSub stream and pushes frames; the client dedupes by sequence.

So the store comes **first**, then the relay — but the relay streams from an **in-memory bus**, not by re-reading the projections. The projections are the durable read model for reloading history.

**Mapping to our design:**
- `orchestration_events` = our append-only log (sqlite).
- projections = our `projection_*` tables (sqlite).
- the in-memory PubSub = our relay's in-memory event bus (a Node `EventEmitter` or small pub/sub) that the WS handler subscribes to.
- **Order:** append + project (awaited) → publish to bus → WS push.

This guarantees durability before the client sees anything, and the client stream is decoupled from the DB read path.

### 3.4 Inbox query draft (v4 §4)
```sql
SELECT s.* FROM projection_sessions s
JOIN projection_projects p ON p.id = s.projectId
WHERE s.state = 'active'
  AND s.noInbox = 0
  AND (s.lastTouchedAt IS NULL OR s.lastTouchedAt >= now - 48h)
ORDER BY COALESCE(s.lastTouchedAt, 0) DESC;
```
`lastTouchedAt` NULL → treated as recent (v4 §10). `noInbox=1` hides regardless.

---

## 4. Project memory: dolt / Beads

- **One shared dolt server.** All projects' Beads live in a **single shared dolt database**, scoped per project (each project = its own beads instance within that one DB). Running 30 projects = 30 beads scopes **in one dolt DB**, not 30 dolt DBs. `main` sees across all (v4 §6).
- **Use the existing `pi-beads-extension`, not a bespoke `beads.ts`.** It already auto-injects `bd prime` output into turns, adds `/beads:*` slash commands (init/ready/create/update/close/prime/…), and wraps the `bd` CLI. In AgentSession SDK mode it's loaded via the SDK's ResourceLoader, just like any extension. The backend calls `bd` CLI directly only where it needs to act outside a session (e.g., seeding a project's memory on creation).
- **Context anchor:** memory is anchored to the **project root** (Beads uses git-repo discovery / `BEADS_DIR`), so it stays valid when the agent `cd`s deep. Execution is anchored to `cwd`. The backend passes **project root (memory) + cwd (execution)** to the pi session — memory travels with the project's directory (v4 §6).
- **No `MEMORY.md`** — dynamic memory lives in Beads (v4 §3.1).

**Scope discipline:** sqlite = session/transcript + project/session *state* (heavy writes, UI reads). dolt = project-level *memory* (working-on/done/next, decisions, insights). They don't overlap; dolt never holds transcripts.

---

## 5. Backend transport: Hono (HTTP + WebSocket)

Confirmed: **Hono** — tiny, TS-native, first-class WS via `@hono/node-ws`. A thin bridge; Hono just gives it a clean home. It can implement the same store patterns t3code uses.

- **REST routes** (state reads + mutations): projects, sessions, inbox, state, memory, schedules. **One vocabulary — `projects`** (dropped the redundant `workspaces` alias; the spec says projects).
- **WS `/api/chat/:id`** — the streaming channel. Browser sends `{type:"prompt", text}` / `{type:"abort"}`; backend forwards to the pi session and streams `text_delta` frames back. Reuses `resolveDeltaChatStreamText` on the client. **No `steer`** — the user steers by abort + re-prompt.
- **Auth:** none in MVP (single-user, behind Cloudflare Access). Gateway Bearer-token + device-auth is deleted.

---

## 8. Concurrency & multi-agent model

- Each open conversation = one in-process `AgentSession` (own cwd, own model, own context). No context bleeding between projects (v4 §0).
- **Project agents:** a project's session sees only its own project dir + memory (dolt db side of it) + `.md` identity files. It knows its specialists exist (lazy) but loads them only when needed.
- **`main` project = the first and admin project.** Nothing special as a project, but its prompt/identity gives it **cross-project awareness** — it knows all projects exist and can see/query across them (v4 §7, §12.4). It is seeded first and is the default home for old/uncategorized sessions.
- **Specialist subagents as projects (v4 §3.2, §9):** web-search, memory/librarian, etc. are their own projects. A project agent spawns one via the **`subagent` tool** when a task needs it.
- **Subagent wiring in AgentSession mode — to explore.** The `subagent` tool needs enabling in the SDK `tools` allowlist. Likely path: a pi extension that registers the `subagent` tool + describes the available specialists in the prompt, so the main/project agent knows what it can spawn. Open exploration item during Phase C; not blocking the first milestone.

---

## 9. Scheduled work (crons, IN MVP — v4 §8)

- **Each type of cron = its own project** (separate-for-separate). E.g. a "summaries" project, a "reports" project — each with its own agent context + memory. (Open alternative to weigh: all crons in one shared project — but leaning separate per type.)
- A **scheduler worker** (`server/scheduler/`) reads `Schedule` rows from sqlite.
- On trigger, it spawns a **headless pi run** with the task + project context, records output, and **creates a NEW conversation in that cron's project** — **one conversation per run, no appending** (v4 §8: results durable + surface on top of the inbox; you choose when to engage).

---

## 10. Identity files (v4 §3.1, §7)

On project creation the backend scaffolds a minimal set of openclaw-style `.md` files at the project root:

- **`AGENTS.md`** — operating rules; the loader pi reads. Can instruct the agent to read the others lazily.
- **`SOUL.md`** — personality. **`IDENTITY.md`** — factual identity. **`USER.md`** — facts about you.

**Dropped:** `MEMORY.md` (Beads owns dynamic memory), `BOOTSTRAP.md`, `HEARTBEAT.md`, and `TOOLS.md`.

**On `TOOLS.md`:** not needed. pi's tool schema comes from the **tools allowlist / tool registration** (the `tools: [...]` array on the session and extension-registered tools), not from a markdown file. Tools are configured programmatically, so a `TOOLS.md` doc would only be prose — skip it.

Files stay **plain on the filesystem**, editable, taking effect when the agent next reads them. Nested `AGENTS.md` are discovered by pi's normal directory walking.

---

## 11. Deployment — 24/7 on the VPS (v4 §0 "kept alive with herdr")

- **The backend must not sleep.** The Hono process is kept alive continuously via **systemd + herdr** run as `pranav` (shares `~/.pi/agent` so pi picks up ollama-cloud + defaultModel). Sessions are held in memory and **rebuilt from sqlite on restart**, so nothing is lost even if the process is recycled.
- **nginx** single upstream → the Hono backend.
- **cloudflared + Cloudflare Access** with an **email allowlist** — no browser token, no device pairing.
- Backend + scheduler under the same unit.

---

*System design DRAFT v2. Review + sign off → `contracts.md` (data shapes) → `step2-files.md` (function signatures).*
