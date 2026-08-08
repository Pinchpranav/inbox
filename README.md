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

To connect: open the app → click the ⚙ in the sidebar header → set
**Gateway URL** to `http://localhost:5174/gw` and paste your **gateway bearer
token** → Save. The status dot turns green when connected. Leave both blank to
run in demo mode (mock data, no gateway).

Env defaults live in `.env.example` (`VITE_GATEWAY_URL`, `VITE_GATEWAY_TOKEN`);
copy to `.env` or set them in the Settings panel.

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

## Deploy notes

Reverse-proxy the gateway under the same origin as the app (e.g. nginx
`/gw/*` → gateway, including WebSocket) so the browser is same-origin — no
CORS. Keep it on https (device auth uses `crypto.subtle`, which needs a secure
context). Set `gateway.controlUi.allowedOrigins` to your domain (or have the
proxy inject a trusted Origin). The shared gateway token lives in the browser
(single-user model); a tiny server-side proxy that holds the token is the
harder-safer alternative.