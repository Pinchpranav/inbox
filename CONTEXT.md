# CONTEXT — where everything lives (read this first)

This repo (`Pinchpranav/inbox`) is the **Pi-Powered Sidebar Agent** — a thin
Vue sidebar + chat app backed by a **Hono + pi + sqlite** backend. It was
rewired **away from OpenClaw** onto its own backend. If you're a fresh agent
starting here, this file tells you where the context is.

## The docs (the source of truth) — `direction/`

All design docs live in this repo under `direction/`. Read them in this order:

1. `functionality_v4.md` — **LOCKED** behavior spec (what/why). Start here.
2. `system 1.md` — system design (the how: Hono + pi + sqlite + dolt).
3. `contracts 7.md` — data shapes + flows (A–E).
4. `step2-files 1.md` — the concrete `server/` file tree + exact TS signatures
   (the build blueprint).

`archive/` holds the build retrospective + review notes (kept for reference).

## The tickets — Beads (this repo's `.beads/`)

The build is tracked as Beads issues (prefix `build`). Run `bd ready` to see the
next ticket. Each ticket has a description + acceptance criteria and is
dependency-wired in order. Work one, push to `main`, `bd close` it, next becomes
ready.

## Current state

- **Backend (`server/`):** built and working. Hono HTTP + WS, one in-process pi
  `AgentSession` per conversation, event-sourcing sqlite store
  (`stateStore.ts`), persist-first relay, in-memory bus. Entry: `server/index.ts`.
- **Frontend (`src/`):** rewired to the Hono backend. `projectsApi.ts` (REST) +
  `chatSocket.ts` (WS `/api/chat/:key`). No OpenClaw anywhere.
- **Deployment (`deploy/`):** one-command bring-up — `deploy/start.sh` builds
  `dist/`, installs `nginx.conf` (serve SPA + proxy `/api`), launches the backend
  in a herdr pane, and reports status. Cloudflare tunnel/access is managed
  separately by the owner.
- **Milestone:** one real conversation streaming end-to-end through the UI on
  ollama-cloud, no OpenClaw — reached.

## Quick commands

```bash
bd ready          # next ticket to work
bd list           # all tickets
bd update --claim <id>   # mark in progress
bd close <id>     # done, next becomes ready

# run locally
npx tsx server/index.ts   # backend on :8787 (needs OLLAMA_API_KEY for chat)
pnpm dev                  # frontend on :5174 (proxies /api -> :8787)
```
