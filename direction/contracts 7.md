# Pi-Powered Sidebar Agent — Contracts (Interfaces Layer)

**Status:** DRAFT v7 (2026-08-14). Written against LOCKED `functionality_v4.md` + `system 1.md`, and the proven steps 2–5.
**Purpose:** Answer **"what do we read, what do we write."** Organized by flow (A–E), each with its contracts beneath it. Duplication with §2 (consolidated reference) is intentional; de-dupe next.
**Predecessor:** `contracts 6.md`. **Next:** `step2-files.md`.

---

## 0. Legend

- **Source** = where the data lives / which layer serves it.
- **Shape** = the exact TypeScript/JSON shape.
- **Role** = what the consumer uses it for.

### 0.1 Scope note (MVP phasing)

This contracts doc reflects the **first implementation** — the core loop (projects, sessions, inbox, conversations, streaming, durability). **Subagents, memory (dolt/Beads), and schedules are in-scope for the MVP but built in later phases**, one at a time, so the first build stays controlled. The architecture is designed to be **extended** for them (the bus, the session manager, and the store all leave seams for these). Where a contract is deferred, it's tagged *(later phase)*.

---

## 1. Flows (narrative + their contracts)

### Flow A — Load the app (sidebar + inbox)

```
Browser               Hono backend          sqlite
  |  GET /api/inbox      |                     |
  |--------------------->|  getInbox()         |  (active + ≤48h + noInbox=0, all projects)
  |                      |-------------------->|
  |                      |<---- Session[] -----|
  |  GET /api/projects   |                     |
  |--------------------->|  getProjects()      |
  |                      |<---- Project[] -----|
  |  GET /api/projects/:id/sessions            |
  |--------------------->|  getSessions(id)    |
  |  <-- render inbox + project folders -----  |
```

**Contracts used in Flow A** (reads):

- `GET /api/inbox` → **Source:** `projection_sessions` · **Role:** the inbox rail (default entry).
```ts
// INBOX shape — only sessions that are active AND not muted appear here.
type InboxSession = { key: string; name: string; projectId: string;
  state: "active";              // must be "active" to qualify
  noInbox: false;               // must be false to appear
  lastTouchedAt: number | null }; // null = treated recent
```
- `GET /api/projects` → **Source:** `projection_projects` · **Role:** project folders + state filter.
```ts
type Project = { id: string; name: string; state: State; dir: string;
  createdAt: number; updatedAt: number };   // emoji dropped (was from OpenClaw agent identity)
```
- `GET /api/projects/:id/sessions` → **Source:** `projection_sessions` · **Role:** rows inside a project.
```ts
// PROJECT SESSIONS — general shape; differs from inbox (any state, may be muted).
type Session = { key: string; name: string; projectId: string;
  state: State;               // "active" | "deferred" | "done"
  noInbox: boolean;           // may be true
  lastTouchedAt: number | null };
```
- Clicking a row = setting `selectedKey` (App state) → drives Flow B.

---

### Flow B — Open / resume a conversation

**B1 · Resume an existing conversation**
```
Browser              Hono backend          piSession            sqlite
  |  GET /api/sessions/:key/messages |          |                   |
  |--------------------------------->|  getMessages(key)           |
  |                                  |----------------------------->|
  |                                  |<-------- Message[] (history) |
  |  <---- Message[] -> render history -----------------------------|
```
`piSession.open()` then **seeds** the `AgentSession` with that history (resume) so the next prompt has context.

**B2 · Open a new session** *(creating a session is a WRITE, not a GET)*
```
Browser              Hono backend            sqlite
  |  POST /api/projects/:id/sessions  |          |
  |---------------------------------->|  create session row (new key)
  |                                   |--------->|
  |  <------ { ok: true; session: { key } } -----|
  |  (then Flow B1 with the NEW key: GET messages = empty, render blank chat)
```
The difference vs resume: **the new `key` is created in sqlite first**, then `AgentSession` starts from a blank state. A session can't be *read* before it *exists*.

**Contracts used in Flow B** (read):

- `GET /api/sessions/:key/messages` → **Source:** `projection_messages` · **Role:** reload transcript. **Not** the live stream source.
```ts
type Message = { id: string; sessionKey: string; role: "user"|"assistant"; text: string;
  timestamp: number; idx: number };   // idx (not 'index' — SQLite reserved word)
```
- `POST /api/projects/:id/sessions` → **In:** `{ name? }` · **Out:** `{ ok: true; session: { key } }` (new key created in sqlite).

---

### Flow C — Send a prompt (the core loop: persist → engine → two consumers)

The user's mental model (confirmed correct): **prompt → DB first → engine calls inference → each answer delta is then handled two ways: relay appends to sqlite (durable) AND the bus streams to the browser (live).**

```
 ① user sends prompt
 Browser ──{WS /api/chat/:key: {type:"prompt", text}}──▶ Hono backend

 ② persist the USER message FIRST (t3code) — durable only, NOT published
 Hono backend ── message.sent (role user) ──▶ sqlite   (append + project)

 ③ open/resume the conversation's AgentSession
 Hono backend ──▶ piSession.open(key, projectDir)      [seeds history if any]

 ④ engine calls the inference provider
 AgentSession ──▶ ollama-cloud ──▶ text_delta stream ──▶ relay

 ⑤ for EACH text_delta, the relay does TWO things (two consumers of the SAME event):
    (a) DURABLE — append to sqlite
        relay ── message.delta (streaming) ──▶ sqlite
    (b) LIVE — publish to the in-memory bus
        relay ──▶ bus ──▶ (WS subscriber) ──{message.delta}──▶ Browser

 ⑥ on text_end, settle the final message the same two ways:
    relay ── message.end (final) ──▶ sqlite     AND
    relay ──▶ bus ──▶ Browser {message.end}

 ── ORDERING RULE ──────────────────────────────────────────────
 Every event is PERSISTED (awaited) BEFORE it is PUBLISHED to the bus.
 sqlite = durable consumer; bus→WS = live consumer.
 The bus carries ONLY assistant output — the user's own message is
 persisted but not published (the browser already rendered it).
```

**Contracts used in Flow C:**

- **WS client → server** (`WS /api/chat/:key`):
```ts
// The session key is carried by the WS URL path (/api/chat/:key), so the
// server already knows which session this connection belongs to. The frame
// therefore does NOT need the key — it's included only defensively.
type ClientFrame =
  | { type: "prompt"; text: string; sessionKey?: string }   // sessionKey optional (defensive)
  | { type: "abort"; sessionKey?: string };                 // no steer
```
- **WS server → client** (WS handler = thin bus subscriber):
```ts
type ServerFrame =
  | { type: "message.delta"; sessionKey: string; messageId: string; text: string }
  | { type: "message.end";   sessionKey: string; message: Message }
  | { type: "status"; sessionKey: string; phase: "streaming"|"idle"|"aborted"|"error" }
  | { type: "error"; sessionKey: string; errorMessage: string };
```
- **Backend ↔ pi (relay)** — persist-first:
| pi SDK event | store event | bus kind |
|---|---|---|
| (user prompt sent) | `message.sent` (role user) | — *(persisted, NOT published — browser already has it)* |
| `text_start` | *(no store event — allocates assistant message id)* | — |
| `text_delta` | `message.sent` (streaming, append) | `message.delta` |
| `text_end` | `message.sent` (final, settle) | `message.end` |
| `tool_call` / `agent_start-end` / abort / error | *(logged/status — later phase)* | — |

> **Persist-before-publish (confirmed):** `text_delta` and `text_end` are each **persisted to sqlite first, then published to the bus**. `text_start` is the exception — it does **not** write to the store, it only allocates the assistant message id; the first `text_delta` creates the row. So the bus only ever carries events that are already durable.

- **Store write event** (`message.sent`):
```ts
payload: { messageId: string; role: "user"|"assistant"; text: string; streaming?: boolean; sessionKey: string }
```
streaming deltas **append** to the projection's `text`; a final `message.sent` **replaces** it.

---

### Flow D — Abort
```
Browser            Hono backend       AgentSession
  | WS abort  ------------------------->|
  |             session.abort() ------->|
  |<---- status:"aborted" frame --------|
```
**Contracts used in Flow D:**
```ts
ClientFrame = { type: "abort"; sessionKey?: string };
ServerFrame = { type: "status"; sessionKey: string; phase: "aborted" };
```

---

### Flow E — REST lifecycle mutations
Each is a single write: `POST/PATCH /api/...` → persist an event → update the projection → respond `{ ok: true }`.

**Contracts used in Flow E** (writes):
- `POST /api/projects` · In `{ name, dir }` · Out `{ ok: true; project: { id } }` · also scaffolds `.md` + dolt scope *(dolt seed later phase)*
- `PATCH /api/projects/:id/state` · `{ state: State }`
- `POST /api/projects/:id/sessions` · In `{ name? }` · Out `{ ok: true; session: { key } }`
- `PATCH /api/sessions/:key/state` · `{ state: State }`
- `PATCH /api/sessions/:key/noInbox` · `{ noInbox: boolean }` (no state change)
- `POST /api/sessions/:key/move` · `{ destProjectId }` (transcript kept, memory resets)
- `POST /api/sessions/:key/model` · `{ model }` → `session.setModel()` *(later phase)*
- `POST /api/schedules` · `{ projectId, cronExpr, task }` *(later phase)*

---

## 2. Consolidated reference (canonical shapes — de-dupe target)

> The same shapes above, collected here as the single reference to edit.

### 2.1 Read contracts
```ts
type State = "active" | "deferred" | "done";   // used by both Project and Session

type Project = { id: string; name: string; state: State; dir: string;
  createdAt: number; updatedAt: number };      // emoji dropped

type Session = { key: string; name: string; projectId: string; state: State;
  noInbox: boolean; lastTouchedAt: number | null };

type InboxSession = { key: string; name: string; projectId: string;
  state: "active"; noInbox: false; lastTouchedAt: number | null };   // subset of Session

type Message = { id: string; sessionKey: string; role: "user"|"assistant"; text: string;
  timestamp: number; idx: number };

type Memory   = { projectId: string; type: string; claim: string; created: number; closed?: number };  // later phase
type Schedule = { id: string; projectId: string; cronExpr: string; task: string; lastRunAt: number };    // later phase
```

### 2.2 Write contracts (REST)
As in Flow E. Each appends to `orchestration_events` + upserts a projection.

### 2.3 WS protocol
As in Flow C/D. The bus carries only assistant output (`message.delta`/`message.end`); the user's own message is persisted but not published.

### 2.4 Backend ↔ pi event map
As in Flow C. **Main-agent tools (proven):** `read`, `bash`, `write`, `edit`. `subagent` **later phase**.

### 2.5 sqlite schema (`stateStore.ts`, proven step 3)
```sql
orchestration_events (sequence PK AUTOINCREMENT, event_type, stream_id, payload_json, created_at)
projection_projects  (id, name, emoji, dir, state, created_at, updated_at)   -- emoji column retained but unused
projection_sessions  (key, name, project_id, state, no_inbox, last_touched_at)
projection_messages  (id, session_key, role, text, is_streaming, timestamp, idx)
projection_state     (projector, last_applied_sequence)   -- rebuild checkpoint
```
> **`projection_threads` (from system §3.2) is intentionally NOT in the MVP schema.** Per-conversation *status* (streaming/idle/aborted) is transient — it lives in the in-memory bus + the UI's `phase` state, not the DB. The durable record is the messages themselves (with `is_streaming`). A `projection_threads` table is a possible future addition if we ever need to persist per-thread status.

### 2.6 Backend ↔ dolt / Beads
`bd prime/show` (read), `bd create/update/close/claim/remember` (write) — one shared dolt DB scoped per project. *(later phase)*

### 2.7 Summary — what reads what
| Consumer | Reads | Writes |
|---|---|---|
| Vue UI | projects, sessions, inbox, messages, memory, schedules | create/set-state/noInbox/move, prompt/abort (WS), set model, create schedule |
| Hono backend | sqlite projections, dolt/Beads, pi events | sqlite log + projections, dolt/Beads, WS frames |
| pi AgentSession | cwd files, `.md` identity files, subagents (later), memory | files, subagent calls (later), memory |
| sqlite | — | append log + upsert projections |
| in-memory bus | (subscribes) | (publishes post-persist) |
| dolt/Beads | — | project memory claims |

---

*Contracts DRAFT v7. Review → `step2-files.md`.*
