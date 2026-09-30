# inbox

Whenever i use agents, i get lost with the quantum of conversations that are going. I needed a project management setup in a mail like inbox setup for any conversations / tasks that i do with agents. That's why this project exists.

A personal agent with projects, threads and an inbox. Idea of the project is to use any models we want with

I use beads for tracking of issues and features.

## Local development

Requires Node.js 24+, pnpm, and a Command Code API key.

```sh
pnpm install
```

Start the backend with `COMMANDCODE_API_KEY` set:

```sh
# Bash
export COMMANDCODE_API_KEY='your-api-key'
pnpm exec tsx server/index.ts
```

```powershell
# PowerShell
$env:COMMANDCODE_API_KEY = 'your-api-key'
pnpm exec tsx server/index.ts
```

In another terminal:

```sh
pnpm dev
```

Open http://localhost:5174. The backend defaults to port 8787. Set
`INBOX_BACKEND_TARGET` when starting Vite if the backend uses another address.
Conversation data is stored in `.inbox/inbox.db` by default (`INBOX_DB` overrides it).

## Validation

```sh
pnpm build
pnpm exec tsc -p server/tsconfig.json
```

## VPS deployment

Install dependencies, nginx, and the backend systemd unit, and set
`COMMANDCODE_API_KEY` in `deploy/.env`. See
[deploy/DEPLOYMENT.md](deploy/DEPLOYMENT.md) for initial setup.

```sh
bash deploy/start.sh
```

This builds the frontend, configures nginx, and starts or restarts the backend.
Cloudflare tunnel and Access setup are managed separately.

```sh
systemctl status inbox-backend
journalctl -u inbox-backend -f
```
