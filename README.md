# inbox-project

A thin standalone web app (Vue 3 + Vite + TypeScript) that turns the
[OpenClaw](https://github.com/openclaw/openclaw) gateway into an inbox-style
sidebar + chat: your projects and threads on the left, the conversation on the
right.

The app owns **only UI state** (selected session, composer, connection). OpenClaw
owns agents / sessions / transcripts / chat; the `projects` plugin owns the
3-state lifecycle (active / deferred / done) + `noInbox`. On refresh we just
re-fetch from the gateway — no database, no event store.

## Two halves, one gateway

| Half | Transport | Talks to |
|---|---|---|
| Sidebar (projects + threads) | REST | the `projects` plugin route `/plugins/projects/api` |
| Chat (history + send + stream) | WebSocket | the gateway protocol (`chat.history`, `chat.send`, `chat.abort`) |

The chat client is the official `@openclaw/gateway-client` (browser export),
with **device auth** (Ed25519 identity in localStorage) so the gateway grants
operator scopes. Auth is the shared gateway token as a bootstrap.

## Local dev

```bash
pnpm install
pnpm dev          # http://localhost:5174
```

The gateway is **not** reachable cross-origin from the browser (its plugin route
doesn't emit CORS headers and 401s the OPTIONS preflight), so the dev server
proxies a same-origin `/gw` prefix to the gateway (see `vite.config.ts`).
`OPENCLAW_GATEWAY_TARGET` (default `http://localhost:18789`) sets the real
gateway.

To connect: open the app → click the ⚙ in the sidebar header → the **Gateway
URL** defaults to the relative `/gw` (works as-is in dev) — paste your
**gateway bearer token** → Save. The status dot turns green when connected. Leave
the token blank to run in demo mode (mock data, no gateway).

Env defaults live in `.env.example` (`VITE_GATEWAY_URL=/gw`, `VITE_GATEWAY_TOKEN`);
copy to `.env` or set them in the Settings panel. The URL is a relative path so
no domain is baked in — dev (Vite `/gw` proxy) and prod (inbox nginx `/gw/`
proxy) use the same value.

## Requirements on the gateway

- The `projects` plugin must be installed + enabled (it's not a built-in plugin).
- A valid model / API key on the gateway is needed for chat replies to stream.

## Project layout

```
src/
  App.vue                 # state + wiring for both halves
  config.ts               # gateway URL/token (env + localStorage)
  components/              # Sidebar, SessionRow, ChatView, MarkdownView, ThemeToggle, SettingsModal
  data/mock.ts            # app domain types (Project/Session/State/Message) + demo seed + isInInbox
  api/
    projectsApi.ts        # REST client for the projects plugin
    gatewayClient.ts      # ChatGatewayClient (wraps @openclaw/gateway-client)
    gatewaySocket.ts      # browser WebSocket adapter
    deviceAuth.ts         # Ed25519 device identity + token store
    chatStream.ts         # resolveDeltaChatStreamText + history mapping
```

## Deployment

The app ships as its own Docker image (multi-stage `Dockerfile`: `node:24-bookworm`
build → `nginx:stable` serve) that fronts the openclaw gateway same-origin. Add
it as a service alongside `openclaw` (builds from this repo) and expose it via
its own subdomain (e.g. `https://inbox.pranavself.uk` over cloudflared):

```yaml
  inbox:
    build:
      context: https://github.com/Pinchpranav/inbox.git#main
    ports:
      - "${INBOX_PORT:-8082}:80"
    depends_on:
      - openclaw
    restart: unless-stopped
```

How it fits together:

- The browser talks **only** to the app's origin (`https://inbox.pranavself.uk`) —
  the app shell at `/` and the gateway at `/gw/...`. The app never reaches the
  gateway's own public domain (`claw.pranavself.uk`, the Control UI entrance).
- The inbox container's nginx (`nginx.conf`) serves the SPA at `/` and
  reverse-proxies `/gw/` (REST + WebSocket) to `http://openclaw:8080` over the
  docker network — same origin, so **no CORS / no preflight** (the gateway plugin
  route doesn't emit CORS headers; same-origin avoids the browser's CORS check).
- **Origin handling (the prescribed way):** the inbox nginx passes the real
  browser `Origin` (`https://inbox.pranavself.uk`) through unchanged. Add that
  origin to `OPENCLAW_ALLOWED_ORIGINS` on the gateway so its WebSocket
  origin-allowlist accepts it (`gateway.controlUi.allowedOrigins` — see the
  openclaw config docs). No Origin injection / loopback trick in prod.
- **Token (Option A):** the gateway bearer token is **not** baked into the image.
  Each user pastes it once in the in-app ⚙ Settings panel (stored in localStorage).
  Anyone with the token gets operator access — fine for a single-user deploy
  behind your own subdomain.
- **Protocol version:** the app pins `@openclaw/gateway-client@2026.7.2-beta.7`
  (protocol `2026.7.2`). The gateway base image must be `2026.7.2` to match.
- HTTPS is required (device auth uses `crypto.subtle`); cloudflared provides it.
  `proxy_read_timeout 86400s` keeps long silent WS streams alive during model
  thinking (nginx's default 60s would kill them).

The shared token in the browser is the single-user tradeoff; a tiny server-side
proxy that holds the token (browser never sees it) is the harder-safer
alternative if you ever want it.