# CONTEXT — where everything lives (read this first)

This repo (`Pinchpranav/inbox`) is the **build target** for the Pi-Powered Sidebar
Agent. It is being rewired **away from OpenClaw** and onto a new Hono + pi backend.
If you're a fresh agent starting here, this file tells you where the context is.

## The docs (the source of truth) — `openclaw-direction/`

All design docs live in `C:/Users/Public/Pi-coding_agent/Openclaw/openclaw-direction/`.
Read them in this order:

1. `functionality_v4.md` — **LOCKED** behavior spec (what/why). Start here.
2. `system 1.md` — system design (the how: Hono + pi + sqlite + dolt).
3. `contracts 7.md` — data shapes + flows (A–E).
4. `step2-files 1.md` — the concrete `server/` file tree + exact TS signatures.
   **This is the build blueprint.** (A plain-language explanation of it is in
   `step2-files-explained/step2-files-explained.txt`.)
5. `notes.txt` — the full decision log / history of how we got here.

## The tickets — Beads (this repo's `.beads/`)

The build is tracked as Beads issues (prefix `build`). Run `bd ready` to see the
next ticket to work. Each ticket has a description + acceptance criteria and is
dependency-wired in order. Work one, push to `main`, `bd close` it, next becomes ready.

## The proven files — `step 2..5` folders

The backend's core files are **already written and proven** (do NOT rewrite them).
They live in the sibling step folders under
`C:/Users/Public/Pi-coding_agent/Openclaw/`:

- `step 3 - SQL Store/stateStore.ts` — event-sourcing store (sqlite, node:sqlite)
- `step 4 - pi session manager and relay/piSession.ts` — one AgentSession per conversation
- `step 4 - pi session manager and relay/relay.ts` — persist-first relay
- `step 5 - in-memory bus/bus.ts` — in-memory EventEmitter bus
- `step 2 - Smoke Test/smoke.ts` — Hono + pi coexistence proof

The build copies these into `server/` and adds the NEW files (`types.ts`, the
`routes/`, `index.ts`) per `step2-files 1.md`.

## Current state

- **Backend:** not built yet. No `server/` exists. (Ticket `build-mhx` is first.)
- **Frontend:** still talks to OpenClaw (`src/api/gatewayClient.ts`,
  `gatewaySocket.ts`, `deviceAuth.ts`, `chatStream.ts`, `projectsApi.ts`).
  These get replaced by the new HTTP + WS client (tickets `build-n9b`, `build-2c9`).
- **Milestone:** one real conversation streaming through the existing UI on
  ollama-cloud, no OpenClaw (ticket `build-2c9`).

## Quick commands

```bash
bd ready          # next ticket to work
bd list           # all tickets
bd update --claim <id>   # mark in progress
bd close <id>     # done, next becomes ready
```
