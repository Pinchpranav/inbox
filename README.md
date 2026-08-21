# inbox — Pi-Powered Sidebar Agent

A thin standalone web app (Vue 3 + Vite + TypeScript) that turns a personal AI
coding agent into an **inbox-style sidebar + chat**: your projects and threads on
the left, the conversation on the right. It streams agent replies live.

The app is **rewired away from OpenClaw** onto its own backend: a **Hono + pi +
sqlite** server. pi is the brain (one in-process `AgentSession` per
conversation); sqlite is the state (event-sourcing + projections). The frontend
owns only UI state and talks to the backend over HTTP + WebSocket.

> **Read `CONTEXT.md` first** — it points to the design docs (`direction/`), the
> Beads build tickets, and the current state.

## Architecture in one line

```
Browser (Vue) ──HTTP + WS──▶ Hono backend (server/) ──▶ pi AgentSession (per conversation)
                                  │                        │ reads/edits files in the project dir
                                  ▼                        ▼
                            sqlite (event log + projections)   ollama-cloud (inference)
```

- **Backend** (`server/`): Hono HTTP + WS. `stateStore.ts` (event-sourcing
  sqlite), `piSession.ts` (one AgentSession per conversation, resume from store),
  `relay.ts` (persist-first → bus), `bus.ts` (in-memory EventEmitter). Entry:
  `server/index.ts`.
- **Frontend** (`src/`): `projectsApi.ts` (REST client), `chatSocket.ts` (WS
  `/api/chat/:key`), components for the sidebar + chat.

## The request model (13 endpoint types)

| # | When | Request |
|---|---|---|
| 1 | load + 5s poll | `GET /api/projects` |
| 2 | load + 5s poll | `GET /api/projects/:id/sessions` (per project) |
| 3 | click a thread | `GET /api/sessions/:key/messages` |
| 4–6 | press **Send** | open `WS /api/chat/:key` → `{type:"prompt",text}` → stream `message.delta` / `message.end` / `status` / `error` |
| 7 | press **Stop** | `{type:"abort"}` over the same WS |
| 8 | new project | `POST /api/projects` `{name,dir}` |
| 9 | new thread | `POST /api/projects/:id/sessions` `{name}` |
| 10–11 | set state | `PATCH /api/projects/:id/state` · `PATCH /api/sessions/:key/state` `{state}` |
| 12 | noInbox toggle | `PATCH /api/sessions/:key/noInbox` `{noInbox}` |
| 13 | move thread | `POST /api/sessions/:key/move` `{destProjectId}` |

> The backend also exposes `GET /api/inbox`, but the frontend currently derives the
> inbox client-side and uses `fetchView()` as its health check.

## Local dev

```bash
# terminal 1 — backend (needs OLLAMA_API_KEY for chat replies to stream)
OLLAMA_API_KEY=<key> npx tsx server/index.ts     # http://localhost:8787

# terminal 2 — frontend
pnpm dev                                          # http://localhost:5174
```

The Vite dev server proxies `/api` (HTTP + WS) to the backend, so the browser
talks to one origin (no CORS). `INBOX_BACKEND_TARGET` (default
`http://localhost:8787`) sets the backend.

## Deployment (24/7 on a VPS)

`deploy/start.sh` is the one command:

```bash
bash deploy/start.sh
```

It is idempotent: `pnpm build` → install `deploy/nginx.conf` (serve `dist/` +
proxy `/api` to the backend) → launch the backend in a **herdr** pane
(self-healing `deploy/backend.sh` while-loop) → report cloudflared status.

- `deploy/nginx.conf` — serves the built SPA at `/` and reverse-proxies `/api/`
  (HTTP + WebSocket) to the backend.
- `deploy/backend.sh` — self-healing wrapper (`while true; do npx tsx
  server/index.ts; done`).
- `deploy/.env` (gitignored; see `.env.example`) — `OLLAMA_API_KEY` + overrides.
- Cloudflare tunnel + Access are managed by the owner (not by `start.sh`).

## Project layout

```
server/            Hono backend (stateStore, piSession, relay, bus, routes, index)
src/               Vue frontend (App.vue, components/, api/, data/mock.ts)
deploy/            nginx.conf, start.sh, backend.sh, .env.example
direction/         design docs (functionality_v4, system, contracts, step2-files)
archive/           retrospective + review notes
```
