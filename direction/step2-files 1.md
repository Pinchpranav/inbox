# Pi-Powered Sidebar Agent — Files & Signatures (step2-files.md)

**Status:** DRAFT v1 (2026-08-14). Written against LOCKED `functionality_v4.md`, `system 1.md`, and `contracts 7.md`, and grounded in the proven steps 2–5.
**Purpose:** The concrete `server/` file tree + exact TypeScript signatures for the **first implementation** (the core loop: projects, sessions, inbox, conversations, streaming, durability).
**Predecessor:** `contracts 7.md`. **Next:** scaffold `server/` from this doc.

---

## 0. Scope (first implementation only)

This doc covers the **core loop only** — projects, sessions, inbox, conversations, streaming, durability. Per contracts §0.1, **subagents, memory (dolt/Beads), and schedules are in-scope for the MVP but built in later phases**; they are tagged `(later phase)` and left as seams (the bus, the session manager, and the store already leave room for them). No `scheduler/`, no `memory/`, no `subagents/` in this tree.

**Proven vs new:**
- **Proven (steps 2–5, do NOT rewrite):** `stateStore.ts` (step 3), `piSession.ts` (step 4), `relay.ts` (step 4→5), `bus.ts` (step 5), and the Hono+pi coexistence pattern (step 2 smoke test).
- **New (Step 6):** the Hono HTTP + WS routes that wire the proven pieces together, plus `types.ts` (protocol shapes) and `index.ts` (entry).

---

## 1. Backend file tree (`server/`)

```
server/
├── index.ts                 # ENTRY (NEW): build store/manager/bus, mount routers, serve HTTP+WS
├── types.ts                 # (NEW): WS protocol frames + InboxSession + Phase (shared shapes)
├── stateStore.ts            # PROVEN (step 3): event-sourcing store + projections
├── piSession.ts             # PROVEN (step 4): one AgentSession per conversation, resume
├── relay.ts                 # PROVEN (step 5): persist-first relay → bus publish
├── bus.ts                   # PROVEN (step 5): in-memory EventEmitter bus
└── routes/
    ├── projects.ts          # (NEW): GET/POST /api/projects, PATCH state, GET/POST sessions
    ├── sessions.ts          # (NEW): GET messages, PATCH state/noInbox, POST move
    ├── inbox.ts             # (NEW): GET /api/inbox
    └── chat.ts              # (NEW): WS /api/chat/:key (the streaming channel)

# ── later phases (NOT in this tree) ─────────────────────────────────
# scheduler/   (crons, v4 §8)   — later phase
# memory/      (dolt/Beads)     — later phase
# subagents/   (specialists)    — later phase
```

**Dependencies (from proven package.json):** `hono`, `@hono/node-server`, `@hono/node-ws`, `@earendil-works/pi-coding-agent`, `pi-ollama-cloud`; dev: `tsx`, `typescript`, `@types/node`. Node ≥ 22.5 (for `node:sqlite`).

---

## 2. `stateStore.ts` — PROVEN (step 3), do not rewrite

Event-sourcing store: append-only `orchestration_events` log (source of truth) + `projection_*` read models rebuilt via upserts, checkpointed in `projection_state`. Uses `node:sqlite` (`DatabaseSync`). Message column is `idx` (not `index`).

Whatever you've written above might be true / false or somewhere inbetween. Idk. But one thing is for sure, that it is not coherent. I'm not able to understand whatever you tried communicating there. Also, explain Event Row. I don't think i have a grip over that. Same goes for this domain event. Also, how does stateStore.ts goes to the SQLite DB? you've written something about node:sqlite. I'm not able to get ig.

**Exported types:**
```ts
export type State = "active" | "deferred" | "done";

export interface Project {
  id: string; name: string; emoji?: string; dir: string;
  state: State; createdAt: number; updatedAt: number;
}

export interface Session {
  key: string;            // "agent:<projectId>:<thread>"
  name: string; projectId: string; state: State;
  noInbox: boolean; lastTouchedAt: number | null;
}

export interface Message {
  id: string; sessionKey: string; role: "user" | "assistant";
  text: string; isStreaming: boolean; timestamp: number; idx: number;
}

export interface EventRow {
  sequence: number; eventType: string; streamId: string;
  payload: Record<string, unknown>; createdAt: number;
}

export type DomainEvent =
  | { type: "project.created"; payload: { project: Project } }
  | { type: "project.state";   payload: { projectId: string; state: State } }
  | { type: "session.created"; payload: { session: Session } }
  | { type: "session.state";   payload: { sessionKey: string; state: State } }
  | { type: "session.noInbox"; payload: { sessionKey: string; noInbox: boolean } }
  | { type: "session.touched"; payload: { sessionKey: string } }
  | { type: "message.sent"; payload: { messageId: string; role: "user"|"assistant"; text: string; streaming?: boolean; sessionKey: string } };
```

**Exported class:**

StateStore class is so that the prompts and answers are stored right? If that's so, i don't think i'm able to understand StateStore class with that constructor, close void thing. 

Append event makes sense. What's that unknown in that payload. Remove it if you can. Have it if you can have a proper reason. I don't get readFromSequence? Why is that required.

I also don't get the write DomainEvent. The good thing here is that we're copying exactly what t3code is doing. But what's bad is i don't think i have grip over it. The get stuff is pretty clear to me tho. No doubts in that 4 get stuff.

```ts
export class StateStore {
  constructor(path: string);
  close(): void;

  // log (append)
  appendEvent(eventType: string, streamId: string, payload: Record<string, unknown>, createdAt?: number): number;
  readFromSequence(sequenceExclusive: number, limit?: number): EventRow[];

  // projections (apply)
  applyEvent(ev: EventRow): boolean;      // true if a projection changed
  rebuildProjections(): void;             // replay from checkpoint

  // core write path: append + project + checkpoint (t3code transaction)
  write(ev: DomainEvent): number;         // returns global sequence

  // read helpers (UI reads)
  getProjects(): Project[];
  getSessions(projectId: string): Session[];
  getMessages(sessionKey: string): Message[];
  getInbox(now?: number, windowMs?: number): Session[];  // default 48h window
}
```

---

## 3. `piSession.ts` — PROVEN (step 4), do not rewrite

Session manager: one in-process `AgentSession` per conversation key; right `cwd` (project dir), model, tools; **resume** = seed `session.agent.state.messages` from the store; isolated `agentDir` (never touches `~/.pi/agent`). Registers the `ollama-cloud` provider before session creation (spike finding).

Why do we have ev: unknown for subscribe

**Exported types:**
```ts
export interface SessionHandle {
  sessionKey: string;
  session: {
    subscribe(cb: (ev: unknown) => void): () => void;
    prompt(text: string): Promise<void>;
    abort(): Promise<void>;
    dispose(): void;
  };
  dispose(): void;
}

export interface PiSessionManagerOpts {
  agentDir: string;
  cwd: string;
  modelProvider?: string;   // default "ollama-cloud"
  modelId?: string;         // default "gemma4:cloud"
}
```

**Exported class:**
```ts
export class PiSessionManager {
  static async create(store: StateStore, opts: PiSessionManagerOpts): Promise<PiSessionManager>;
  async open(sessionKey: string, projectDir: string): Promise<SessionHandle>;  // open or reuse; seeds history if any
  disposeAll(): void;
}
```

---

## 4. `relay.ts` — PROVEN (step 5), do not rewrite

Persist-first relay: captures pi `AgentSession` events, maps them to domain events, **persists to sqlite (awaited) THEN publishes to the bus**. The user's own message is persisted but **not** published (browser already rendered it). The bus carries only assistant output.

**Exported types:**
```ts
export interface RelayResult {
  streamedText: string;
  assistantMessageId: string;
}

export interface AttachedRelay {
  finished: Promise<RelayResult>;   // resolves with full streamed text at text_end
  unsubscribe(): void;
}
```

**Exported functions:**

Here we have this subscribe ev: PiEvent. What's a PiEvent. Explain what's happening the subscribe i suppose. Most likely it's publishing that delta?? I approve of that logic written in the // comments tho.

```ts
// Persist the user prompt BEFORE the engine runs (t3code ordering). Returns messageId.
export function recordUserMessage(store: StateStore, sessionKey: string, text: string): string;

// Attach to a session; persist + publish each assistant delta/end. Returns a handle.
export function attachAssistantRelay(
  store: StateStore,
  sessionKey: string,
  session: { subscribe(cb: (ev: PiEvent) => void): () => void },
): AttachedRelay;
```

**Event map (contracts Flow C):** `text_start` → allocates assistant id (no store write); `text_delta` → persist `message.sent` (streaming, append) + publish `message.delta`; `text_end` → persist `message.sent` (final, replace) + publish `message.end`.

---

## 5. `bus.ts` — PROVEN (step 5), do not rewrite

In-memory event bus (Node `EventEmitter`). Decouples the durable sqlite write from the live client push. The relay publishes post-commit; the WS route subscribes.

What's the kind field present in BusEvent? Why we need sequence. I get that this has something to do with the sqlite log. But i don't get the flow i suppose. 

**Exported:**
```ts
export type BusEventKind = "message.sent" | "message.delta" | "message.end";

export interface BusEvent {
  sessionKey: string;
  kind: BusEventKind;
  messageId: string;
  role: "user" | "assistant";
  text: string;
  streaming?: boolean;
  sequence: number;          // global ordering key from the sqlite log
}

export const EVENT = "event";   // the event name relay emits / subscribers listen for
export const bus = new EventEmitter();   // setMaxListeners(0)
```

---

## 6. `types.ts` — NEW (Step 6)

Shared protocol shapes not already in `stateStore.ts`. Re-exports `State` from the store and adds the WS frames + inbox subset.

I'm just thinking out loud. Why are we have two types files. stateStore specifically for the session store, project store and this is other types? i just wanted to get a grip. 

So, in essence there are three types here - InboxSession - this is clear to me, ClientFrame - so, this for the browser to server thing? and then the server frame is for browser to client. Explain the ClientFrame and Serverframe. Basis my understanding i'll write ig. Client frame has two things. Both are pretty clear actually. Sending prompt to the server and sending abort to the prompt. Clear actually. ServerFrame is for four things. So, this is information as to how the message is flowing in the browser but i don't think i completely get where the information is flowing from and to.

```ts
import type { State } from "./stateStore.ts";

export type { State };

// contracts Flow A — inbox subset of Session (active + not muted)
export type InboxSession = {
  key: string; name: string; projectId: string;
  state: "active"; noInbox: false; lastTouchedAt: number | null;
};

// contracts Flow C/D — WS client → server (key carried by the URL path)
export type ClientFrame =
  | { type: "prompt"; text: string; sessionKey?: string }   // sessionKey optional (defensive)
  | { type: "abort";  sessionKey?: string };

// contracts Flow C/D — WS server → client (thin bus subscriber)
export type Phase = "streaming" | "idle" | "aborted" | "error";
export type ServerFrame =
  | { type: "message.delta"; sessionKey: string; messageId: string; text: string }
  | { type: "message.end";   sessionKey: string; message: Message }
  | { type: "status";        sessionKey: string; phase: Phase }
  | { type: "error";         sessionKey: string; errorMessage: string };
```

---

## 7. `routes/projects.ts` — NEW (Step 6)

HTTP routes for projects + their sessions (contracts Flow A reads, Flow B2 + Flow E writes). Each write appends to the log + upserts a projection, then returns `{ ok: true }`.

```ts
import { Hono } from "hono";
import type { StateStore } from "../stateStore.ts";

export function createProjectsRouter(store: StateStore): Hono;
```

**Handlers:**

These are pretty clear. I'm happy with these

| Method  | Path                         | In                              | Out                              | Store call                                      |
| ------- | ---------------------------- | ------------------------------- | -------------------------------- | ----------------------------------------------- |
| `GET`   | `/api/projects`              | —                               | `Project[]`                      | `getProjects()`                                 |
| `POST`  | `/api/projects`              | `{ name: string; dir: string }` | `{ ok: true; project: { id } }`  | `write(project.created)` + scaffold `.md` files |
| `PATCH` | `/api/projects/:id/state`    | `{ state: State }`              | `{ ok: true }`                   | `write(project.state)`                          |
| `GET`   | `/api/projects/:id/sessions` | —                               | `Session[]`                      | `getSessions(id)`                               |
| `POST`  | `/api/projects/:id/sessions` | `{ name?: string }`             | `{ ok: true; session: { key } }` | `write(session.created)`                        |

> **POST /api/projects** also scaffolds the identity `.md` files (`AGENTS.md`, `SOUL.md`, `IDENTITY.md`, `USER.md`) at `dir` (system §10). Dolt/Beads scope seeding is `(later phase)`.

---

## 8. `routes/sessions.ts` — NEW (Step 6)

HTTP routes for a single conversation (contracts Flow B1 read, Flow E writes).

```ts
import { Hono } from "hono";
import type { StateStore } from "../stateStore.ts";

export function createSessionsRouter(store: StateStore): Hono;
```

**Handlers:**

I don't think creating a new session is there. First one is for history. Oh wait, it's for both old and new sessions. Just that if it's an old session we get the transcript as well. Gotcha. Fine only then.

| Method  | Path                          | In                          | Out                             | Store call                                                           |
| ------- | ----------------------------- | --------------------------- | ------------------------------- | -------------------------------------------------------------------- |
| `GET`   | `/api/sessions/:key/messages` | —                           | `Message[]` (history, not live) | `getMessages(key)`                                                   |
| `PATCH` | `/api/sessions/:key/state`    | `{ state: State }`          | `{ ok: true }`                  | `write(session.state)`                                               |
| `PATCH` | `/api/sessions/:key/noInbox`  | `{ noInbox: boolean }`      | `{ ok: true }`                  | `write(session.noInbox)`                                             |
| `POST`  | `/api/sessions/:key/move`     | `{ destProjectId: string }` | `{ ok: true }`                  | `write(session.created)` w/ new key (transcript kept, memory resets) |

> `POST /api/sessions/:key/model` → `session.setModel()` is `(later phase)`.

---

## 9. `routes/inbox.ts` — NEW (Step 6)

The inbox rail (contracts Flow A). Thin wrapper over the store's inbox query.

```ts
import { Hono } from "hono";
import type { StateStore } from "../stateStore.ts";

export function createInboxRouter(store: StateStore): Hono;
```

**Handlers:**

Sure, LGTM

| Method | Path | In | Out | Store call |
|---|---|---|---|---|
| `GET` | `/api/inbox` | — | `InboxSession[]` | `getInbox()` (active + ≤48h + noInbox=0, all projects) |

---

## 10. `routes/chat.ts` — NEW (Step 6)

The WebSocket streaming channel (contracts Flow C/D). This is where the proven pieces get wired together: on `prompt` → persist user msg → open/resume the session → attach the relay → run the engine; the relay persists + publishes to the bus; this route subscribes to the bus and forwards frames to the browser.

I think i might need a bit more than this here. I'm not doubting your code per se. It's just that how

prompt - > persisting the user message -> opening / resume a session -> attaching relay -> engine -> relay persist -> relay gets published to the in-memory bus -> browser

I get that this is the logic but i don't get how this logic is implemented as code. You get me?

```ts
import { Hono } from "hono";
import type { StateStore } from "../stateStore.ts";
import type { PiSessionManager } from "../piSession.ts";
import { bus, EVENT, type BusEvent } from "../bus.ts";

export interface ChatDeps {
  store: StateStore;
  manager: PiSessionManager;
  projectDirFor: (sessionKey: string) => string;   // resolve project dir from a session key
}

export function createChatRouter(deps: ChatDeps): Hono;
```

**Handler — `WS /api/chat/:key` (upgrade):**
```ts
// On connection:
//   subscribe to bus (EVENT) filtered by sessionKey === :key
//   forward each BusEvent as a ServerFrame:
//     message.delta -> { type:"message.delta", sessionKey, messageId, text }
//     message.end   -> { type:"message.end",   sessionKey, message }
//   on close: unsubscribe

// On ClientFrame { type:"prompt", text }:
//   recordUserMessage(store, key, text)              // persist user msg (NOT published)
//   const handle = await manager.open(key, projectDirFor(key))   // open/resume
//   const relay = attachAssistantRelay(store, key, handle.session) // persist + publish
//   await handle.session.prompt(text)                // run the engine
//   await relay.finished                             // turn done
//   send { type:"status", phase:"idle" }

// On ClientFrame { type:"abort" }:
//   await handle.session.abort()
//   send { type:"status", phase:"aborted" }
```

> **Ordering rule (contracts Flow C):** every event is persisted (awaited) before it is published to the bus. The bus carries only assistant output; the user's own message is persisted but not published.

---

## 11. `index.ts` — NEW (Step 6)

Server entry: build the store, session manager, and bus; mount all routers; serve HTTP + WS. Kept alive 24/7 (systemd + herdr, system §11).

You have to explain it better i suppose. I understand that this where everything comes together. So, we build the store (SQLite here) then the session manager and in-memory bus... You gotta explain better to me i suppose. I don't think i'm able to completely grasp what we're trying to do here.

```ts
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { serve as serveWs } from "@hono/node-ws";
import { StateStore } from "./stateStore.ts";
import { PiSessionManager } from "./piSession.ts";
import { createProjectsRouter } from "./routes/projects.ts";
import { createSessionsRouter } from "./routes/sessions.ts";
import { createInboxRouter } from "./routes/inbox.ts";
import { createChatRouter } from "./routes/chat.ts";

export interface AppDeps {
  dbPath: string;
  agentDir: string;
  cwd: string;                 // default project dir for new sessions
  port?: number;               // default 8787
}

export function buildApp(deps: AppDeps): { app: Hono; store: StateStore; manager: PiSessionManager };

export async function main(deps: AppDeps): Promise<void>;
//   store = new StateStore(dbPath); store.rebuildProjections();
//   manager = await PiSessionManager.create(store, { agentDir, cwd });
//   app = buildApp(...)  → mount /api/projects, /api/sessions, /api/inbox, /api/chat
//   serve HTTP + WS on port
//   graceful shutdown: manager.disposeAll(); store.close();
```

---

## 12. Proven vs new — summary

| File | Status | Source |
|---|---|---|
| `stateStore.ts` | **PROVEN** (step 3) | `step 3 - SQL Store/stateStore.ts` |
| `piSession.ts` | **PROVEN** (step 4) | `step 4 - pi session manager and relay/piSession.ts` |
| `relay.ts` | **PROVEN** (step 5) | `step 5 - in-memory bus/relay.ts` |
| `bus.ts` | **PROVEN** (step 5) | `step 5 - in-memory bus/bus.ts` |
| Hono + pi coexistence | **PROVEN** (step 2) | `step 2 - Smoke Test/smoke.ts` |
| `types.ts` | **NEW** (Step 6) | protocol shapes from contracts |
| `routes/projects.ts` | **NEW** (Step 6) | wires store → HTTP |
| `routes/sessions.ts` | **NEW** (Step 6) | wires store → HTTP |
| `routes/inbox.ts` | **NEW** (Step 6) | wires store → HTTP |
| `routes/chat.ts` | **NEW** (Step 6) | wires store + manager + relay + bus → WS |
| `index.ts` | **NEW** (Step 6) | entry, mounts everything |

**Later phases (seams left, not built):** `scheduler/` (crons), `memory/` (dolt/Beads), `subagents/` (specialists), `POST /api/sessions/:key/model`, `projection_threads` table.

---

*Files & signatures DRAFT v1. Review → scaffold `server/`.*
