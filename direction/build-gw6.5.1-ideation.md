# Ideation + code-review notes — build-gw6.5.1

Companion to `PLAN_model_picker.md` (the agreed source of truth). This file
captures what I found reading the *actual* code versus the design, the open
questions with recommendations, and an updated subtask plan. Ideation only —
no implementation yet.

## A. Spike (subtask 1) — CONFIRMED ✅

Read the pi SDK (`@earendil-works/pi-coding-agent@0.84.3` → `pi-agent-core@0.84.2`):

- `AgentSession.setModel(model: Model<any>): Promise<void>` — `agent-session.d.ts:441`
- `AgentSession.setThinkingLevel(level: ThinkingLevel): void` — `agent-session.d.ts:456`
- `AgentSession.getAvailableThinkingLevels(): ThinkingLevel[]` — `agent-session.d.ts:466`
- `ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"`
  (`pi-agent-core/dist/types.d.ts:260`) — exactly matches `PI_THINKING_LEVELS` in
  `commandCode.ts`.
- `ModelRuntime.getModel(providerId, modelId): Model | undefined` — `model-runtime.d.ts:65`

So `open()` can do `await session.setModel(getModel(provider, storedId))` then
`session.setThinkingLevel(level)` before `prompt()`. Spike done — close it.

## B. Gaps found reading the code (not in the design doc)

**B1 — `store.getSession(key)` singular does not exist.** The design's
"Apply on open" step says `open()` reads `store.getSession(key).modelId/thinkingLevel`.
`StateStore` only has `getSessions(projectId)` (`stateStore.ts:386`).
Fix: add `getSession(key)` (or in `open()` derive `projectId = key.split(":")[1]`
and `.find(s => s.key === key)`). Recommend a real `getSession(key)`.

**B2 — new columns need an ALTER, not CREATE IF NOT EXISTS.** `migrate()` only
creates tables `IF NOT EXISTS` (`stateStore.ts:73`). Adding `model_id`/`thinking_level`
to `projection_sessions` requires
`ALTER TABLE projection_sessions ADD COLUMN IF NOT EXISTS model_id TEXT;` +
`... thinking_level TEXT;` so existing `.inbox/inbox.db` files upgrade in place.
Node 22's sqlite supports `ADD COLUMN IF NOT EXISTS`.

**B3 — `Session` interface + read map + upsert need the two fields.**
- `Session` (stateStore.ts:46) gains `modelId?: string; thinkingLevel?: PiThinkingLevel;`
  (optional so older rows/projections still map).
- `getSessions` map (stateStore.ts:387) adds `modelId`, `thinkingLevel`.
- `upsertSession` (stateStore.ts:330) writes them; `session.created` defaults
  `modelId = null` (→ treated as the manager default), `thinkingLevel = "off"`.
- `applyEvent` gains `session.model` and `session.thinking` cases (mirror `session.noInbox`).

**B4 — cached handles won't pick up a model/thinking change.** `open()` returns
the existing handle if one is cached (`piSession.ts` `if (existing) return existing`)
and only sets the model at *create* time via `createAgentSession({ model })`.
If the user changes model/thinking while the handle is live (it stays in `handles`
until `disposeAll`), the next prompt reuses the old model.
Fix options:
- (B4a) In `open()`, after fetching/creating the handle, ALWAYS apply the stored
  model/thinking to the session (`await session.setModel(...)`, `session.setThinkingLevel(...)`).
  Cheap + idempotent; works for both new and cached handles. ← recommended.
- (B4b) On the `PATCH /model`|`/thinking` route, if `manager.handles` has the key,
  call `setModel`/`setThinkingLevel` on the live session immediately.

**B5 — validate inputs in the routes.** `PATCH /model` with an unknown id would
store a string that makes `getModel(provider, id)` return `undefined` → `open()`
throws ("model not found"). Validate: model id must be in `this.models`
(`getModels()` ids); thinking level must be in `PI_THINKING_LEVELS`. 400 otherwise.
Also guard B4a: if stored `modelId` isn't in the catalog (model removed upstream),
fall back to the manager default rather than throwing.

**B6 — thinking level validity vs. model.** A stored level (e.g. `max`) may be
invalid for the model now selected. `setThinkingLevel(level)` likely clamps, but
to be safe cross-check `session.getAvailableThinkingLevels()` after `setModel`
and clamp (or reset to `off`). Minor; flag in implementation.

**B7 — demo mode (backend unreachable).** `App.vue` falls back to mock data
(`loadDemoSeed`). The Composer picker needs `models` from `GET /api/models`, which
fails in demo mode → picker should render disabled/empty with a placeholder.
ZDR toggle in Sidebar already POSTs and rolls back on failure; keep that. Decide:
static fallback list in demo, or just disabled. Recommend disabled + tooltip.

**B8 — `＋` attach stub.** Native `<input type=file>` only; no model wiring
(phase-2 per gw6). Fine.

## C. Open questions — recommendations

- **Q1 (rename target):** `domain.ts` not `types.ts`. Reason: it holds
  `Project/Session/Message/State` + helpers (`isInInbox`, `stateLabel`), i.e. domain
  types + rules, not just structural types; and `server/types.ts` already owns the
  wire-protocol name, so `types.ts` would be ambiguous. Update ~all `../data/mock`
  imports (projectsApi.ts, App.vue, ChatView.vue, Sidebar.vue).
- **Q2 (SettingsModal orphaned by removing ⚙):** DON'T drop. The backend-URL config
  is still needed for the demo fallback / reconnect. Recommend a tiny `⋯` button
  next to the connection dot that opens `SettingsModal`. (Long-press conn dot is
  fiddly on desktop; `⋯` is clearer.) Keep the conn dot as the status indicator.
- **Q3 (new):** Add `getSession(key)` + the ALTER migration (B1/B2).
- **Q4 (new):** Apply stored model/thinking in `open()` unconditionally (B4a).

## D. Updated subtask plan (ordered)

1. ✅ Spike: confirm `setModel`/`setThinkingLevel`/`getAvailableThinkingLevels` — DONE.
2. Backend store: `model_id`/`thinking_level` cols (ALTER in migrate), `Session`
   fields, `getSession(key)`, `session.model`/`session.thinking` events + `applyEvent`
   cases, `getSessions`/`upsertSession` map. (B2/B3/B1)
3. Backend manager: promote `this.models` field; `getModels()` pure composition over
   `commandCode.ts` helpers; apply stored model/thinking in `open()` (B4a/B5/B6).
4. Backend routes: `GET /api/models`, `PATCH /api/sessions/:key/model` (validate),
   `PATCH /api/sessions/:key/thinking` (validate); ZDR route unchanged. (B5)
5. Frontend api: `getModels()`, `setSessionModel()`, `setSessionThinking()`; map
   `modelId`/`thinkingLevel` in `BackendSession`→`Session`.
6. Frontend Composer.vue: input shell (`＋` stub, auto-grow textarea, send ↑→■ stop)
   + control row (`[Model ▾]`, `[thinking: off ▾]` click + Shift+Tab cycle); emits
   `send`/`abort`/`model`/`thinking`; mount in ChatView; drop ZDR button + old composer.
7. Frontend Sidebar ZDR toggle (replace ⚙, keep conn dot, add `⋯`→SettingsModal) +
   App.vue state ownership (fetch `/api/models` once, hold per-session modelId/
   thinkingLevel seeded from session, optimistic PATCH on emit).
8. Refactor: rename `data/mock.ts`→`data/domain.ts` + update imports. (Q1)
9. Deferred: 422 `cmd_zdr_no_providers` toast; image-attach→model wiring; per-conversation ZDR.

## G. Locked decisions (owner, post-ideation)

- **Thinking levels = hardcoded per-model table** in `commandCode.ts`. The live
  `/provider/v1/models` API does not expose reasoning/thinking metadata, so there
  is no way to derive it — the static `MODEL_EFFORTS` table (per-model) is the
  source of truth. Accept that; don't invent a fetch for it.
- **Model card shape = `{ id, name, thinkingLevelMap, input }`** — DROP the separate
  `reasoning` boolean. "Does this model reason?" == "does it have a thinkingLevelMap?"
  The hardcoded per-model table *is* the thinkingLevelMap source; no effort→map
  translation layer. (`getModels()` composes this directly over `commandCode.ts`.)
- **Event-sourcing model (the "why" for station 3):** the log table
  `orchestration_events` is the REAL store; `projection_sessions` is a replayable
  cache. Every attribute change = append a typed event + an `applyEvent` replay
  rule — NOT edit a row directly. So model/thinking = two new event types
  (`session.model`, `session.thinking`) + two `applyEvent` cases + one ALTER on
  `projection_sessions` (the only table change; the log gets new rows for free
  because events are free-form json). The ONLY payloads that create those log rows
  are the two routes:
  `PATCH /model` → `store.write({type:"session.model", payload:{sessionKey, modelId}})`
  `PATCH /thinking` → `store.write({type:"session.thinking", payload:{sessionKey, level}})`
- **Provider-agnosticism:** command-code only appears at station 1 (fetch) + the
  manager's one `modelProvider` knob + api base url. model/thinking are plain
  strings everywhere above. Swap provider = rewrite `commandCode.ts` + flip the knob.
- Open questions resolved: rename `data/mock.ts`→`data/domain.ts`; keep SettingsModal,
  expose via a `⋯` by the conn dot (don't drop the gear's function when removing ⚙).

## H. Status

Backend ideation closed (stations 1–4). **Backend + frontend implemented, typechecked, built, and e2e-smoke-tested.**
- store/manager/routes: storage round-trips and survives restart; old-DB ALTER upgrade is idempotent.
- frontend: `data/mock.ts`→`data/domain.ts`; `Composer.vue` (model dropdown + thinking pill + input shell
  with ＋ stub / ↑ send → ■ stop); ZDR moved to Sidebar (global, `⋯` keeps SettingsModal); App.vue owns
  `models[]` + per-session modelId/thinkingLevel with optimistic PATCH. `vue-tsc -b` + `vite build` clean.
- e2e: live catalog served, PATCH routes persist + validate, stored session correct.
- The `reasoning` field was dropped (model card = `{id,name,thinkingLevelMap,input}`).

## F. Suggested execution shape (decision for owner)

- Close spike (subtask 1).
- Backend subtasks 2–4 as one change/PR (store + manager + routes), behind one child bead.
- Frontend subtasks 5–7 as a second change/PR, behind another child bead.
- Refactor (8) last, separate, mechanical.
- Validate with `npx tsx server/index.ts` + a quick PATCH/GET round-trip, and
  `pnpm build` (vue-tsc) for the frontend.
