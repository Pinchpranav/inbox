# Design: model picker + thinking pill (chat composer) + ZDR global (sidebar)

Refines **build-gw6.5** with a pattern-consistent design. ZDR is **global** (manager-level),
moved to the **sidebar**; model picker + thinking control live in the **chat composer**.

## Agreed decisions
- **ZDR = global**, stays in the manager (no per-session). Toggle moves to the **sidebar**
  (replaces the ⚙ gear); the connection dot stays.
- **Model picker + thinking control live in the chat composer**, at the **bottom**:
  - **Input shell** (top): `＋` attach (stub), auto-grow textarea (Enter=send, Shift+Enter=NL),
    **send ↑ arrow bottom-right → ■ stop while streaming**.
  - **Control row** (bottom, below input): `[Model ▾]` and `[thinking: off ▾]`.
- **Per-session model + thinking persist** (survive reload) via the event-sourced store.
- **`＋` attach** = stub (native file picker; image→model wiring is phase-2 per gw6).

## Data flow
```
Sidebar  [ZDR ●/○]  → POST /api/sessions/zdr (global, unchanged)
Composer [Model ▾][thinking ▾] + [+ input ↑]
   → PATCH /api/sessions/:key/model   {model}
   → PATCH /api/sessions/:key/thinking {level}
   → GET /api/models  (catalog w/ thinkingLevelMap)
App.vue holds models[], current session modelId/thinkingLevel; PATCH on change (optimistic).
manager.open(key): read stored modelId/thinkingLevel → session.setModel()/setThinkingLevel() before prompt().
```

## Backend
### `id` clarification (verified against live /provider/v1/models)
The API returns `{object:"list", data:[{id, object, created, owned_by, name, context_length}]}`.
**`id` is the OpenAI-compatible model slug** sent to `/chat/completions`
(e.g. `claude-sonnet-5`, `deepseek/deepseek-v4-flash`). Our `commandCode.ts` already maps it
correctly (`id: m.id`). `getModels()` returns `{id, name, reasoning, input, thinkingLevelMap}` —
`id` is that slug, exactly what `modelRuntime.getModel(provider, id)` expects. ✅
`reasoning` and `thinkingLevelMap` are **derived** from the static `MODEL_EFFORTS` table
(the API does not expose them) — no change to id semantics.

### `manager.getModels()` (server/piSession.ts)
- Cache the fetched catalog: store `this.models` from `fetchModels()` (today it's a local var in
  `registerCommandCode` — promote to an instance field so `getModels()` can read it).
- `getModels()` returns `this.models.map(m => ({ id: m.id, name: m.name,
  reasoning: <MODEL_EFFORTS has id>, input: inputModalitiesForModel(m.id),
  thinkingLevelMap: thinkingMetadataForModel(m.id)?.thinkingLevelMap }))`.
  This is **pure composition** over existing `commandCode.ts` helpers — no new model logic.

### Store change is the *only* core change — and it is pattern-consistent (NOT a "patch")
`stateStore.ts` already supports per-session attributes via the event-sourcing pattern:
`session.state` and `session.noInbox` are domain events → `projection_sessions` columns.
We **extend that exact pattern**:
- New columns: `model_id TEXT`, `thinking_level TEXT` on `projection_sessions`.
- New domain events: `session.model {sessionKey, modelId}`, `session.thinking {sessionKey, level}`
  (added to the `DomainEvent` union; `applyEvent` handles them like the existing two).
- `getSessions` returns `modelId`/`thinkingLevel` (it already returns the projection row).
This is the established extension mechanism of an event-sourced store — not special-casing.
ZDR stays out of the store (global).

### Routes (server/routes/sessions.ts)
- `GET /api/models` → `manager.getModels()`.
- `PATCH /api/sessions/:key/model` `{model}` → `store.write({type:"session.model", ...})`
  (shape mirrors `session.noInbox`).
- `PATCH /api/sessions/:key/thinking` `{level}` → `store.write({type:"session.thinking", ...})`.
- Global `POST /api/sessions/zdr` stays as-is.

### Apply on open (server/piSession.ts)
`open(key)` reads `store.getSession(key).modelId`/`thinkingLevel` (default model per existing
default; default thinking `off`) and calls `session.setModel(getModel(provider, id))` +
`session.setThinkingLevel(level)` before `prompt()`.

## Frontend
### Sidebar.vue
Remove ⚙ gear; add `[ZDR ●/○]` toggle bound to a global `zdrOn` ref (POST /api/sessions/zdr).
Connection dot unchanged.

### Composer.vue (new)
Replaces the textarea/Send in ChatView footer. Structure:
- **Input shell** (top): `＋` (file picker stub), auto-grow textarea (Enter=send,
  Shift+Enter=NL), **send ↑ arrow bottom-right → ■ stop while streaming**.
- **Control row** (bottom, below input): `[Model ▾]` dropdown (from `models`),
  `[thinking: off ▾]` pill that cycles `["off", ...Object.keys(thinkingLevelMap)]`
  (click + Shift+Tab; disabled when model has no thinking).
- Emits: `send`, `abort`, `model(id)`, `thinking(level)`.

### ChatView.vue
Drop its ZDR button + old composer; mount `<Composer>` in footer; pass `models`, `modelId`,
`thinkingLevel`.

### App.vue (state ownership)
- Fetch `/api/models` once → `models[]`.
- Hold per-session `modelId`/`thinkingLevel`, seeded from the enriched session object;
  on Composer `model`/`thinking` emit → optimistic update + `api.setSessionModel/Thinking`.
  Survives reload (store owns it).

### projectsApi.ts — placement
Pure HTTP transport, **same shape as existing `setNoInbox(key, bool)` / `setSessionState(key, State)`**:
- `getModels()`
- `setSessionModel(key, modelId)`
- `setSessionThinking(key, level)`
(App.vue owns state + calls these; components emit intent only.)

### data/mock.ts → rename (refactor, separate bead)
No longer mock data; holds domain types (`Project/Session/Message/State`) + seed.
Rename to `src/data/domain.ts` (or `types.ts`) and update ~all imports. Mechanical;
tracked separately from the feature.

## Out of scope / deferred
- 422 `cmd_zdr_no_providers` toast (follow-up bead; picker/thinking don't need it).
- Image attach → model input wiring (phase-2 per gw6).
- Per-conversation ZDR (explicitly deferred; global only now).

## Open questions
1. `data/mock.ts` rename target: `domain.ts` vs `types.ts`?
2. SettingsModal (edits backend URL) is orphaned by removing ⚙. Keep a minimal access
   (long-press connection dot / tiny ⋯) or drop entirely?

## Subtask breakdown (spawn as child beads when starting work)
1. Spike: confirm `AgentSession.setModel()` + `getAvailableThinkingLevels()` behave as assumed.
2. Backend: `manager.getModels()` + cache `this.models`; `GET /api/models`.
3. Backend: store `model_id`/`thinking_level` + `session.model`/`session.thinking` events;
   `getSessions` returns them.
4. Backend: `PATCH /api/sessions/:key/model` + `/thinking`; apply in `open()`.
5. Frontend: `projectsApi.ts` `getModels/setSessionModel/setSessionThinking`.
6. Frontend: `Composer.vue` (input shell + control row); mount in `ChatView`; drop ZDR button there.
7. Frontend: Sidebar ZDR toggle (replace ⚙); App.vue state ownership + wiring; Shift+Tab cycle.
8. Refactor: rename `data/mock.ts` → `data/domain.ts` + update imports.
9. Deferred: 422 toast; image attach wiring.
