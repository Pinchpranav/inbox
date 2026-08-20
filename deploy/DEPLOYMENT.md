# Deployment Runbook — inbox on the VPS (build-a8l)

**Status:** DONE (2026-08-19). This is the *actual* how-we-did-it + how-to-reproduce
doc, written after the fact. The design intent lives in
`direction/deployment plan.md`; this file is the operational record and the
clean-box reproduction path.

---

## 0. Final topology (what's running)

```
Browser → Cloudflare Access (email allowlist) → cloudflared tunnel
    → nginx (127.0.0.1:8085)          ← NOT :80 (Coolify owns :80)
        ├── /           serves built SPA (dist/)          ← pnpm build
        └── /api/*      reverse-proxy (HTTP + WS) → backend :8787
                                             ↑
                              systemd: inbox-backend.service
                              (Restart=on-failure, survives reboot)
```

| Piece | Runs as | Listener |
|---|---|---|
| Backend (`npx tsx server/index.ts`) | systemd `inbox-backend.service` → `deploy/backend.sh` | `127.0.0.1:8787` |
| Frontend (`dist/`) | nginx (apt) | `127.0.0.1:8085` |
| `/api` proxy (REST + WS) | nginx rule | `127.0.0.1:8085` |
| Tunnel + TLS + access | cloudflared + Cloudflare Access | owner-managed |

Key facts about this box:
- **Coolify runs its own nginx on `:80`** — our nginx must stay on loopback `:8085`.
- **`:443` is Tailscale**, not HTTP.
- **node is under nvm** (`~/.nvm/versions/node/v24.19.0/bin`) — systemd does NOT
  load shell profiles, so the unit must put the nvm bin on `PATH` explicitly.
- **No passwordless sudo** — `sudo` prompts for a password.

---

## 1. Reproduce on a clean box (the happy path)

### 1.1 Prereqs
```bash
node -v && git --version          # node 24+ (ships corepack)
corepack enable pnpm              # installs pnpm
sudo apt update && sudo apt install -y nginx
```

### 1.2 Clone + secrets + deps
```bash
git clone https://github.com/Pinchpranav/inbox.git
cd inbox
cp deploy/.env.example deploy/.env
nano deploy/.env                  # paste OLLAMA_API_KEY
pnpm install                      # pnpm-workspace.yaml approves esbuild's build script
```

### 1.3 Smoke-test the backend before systemd
```bash
./deploy/backend.sh               # foreground; Ctrl-C after test
# 2nd SSH:  curl -s http://localhost:8787/api/health   -> {"ok":true}
```

### 1.4 Install the systemd unit (paths + user + nvm PATH)
```bash
sudo cp deploy/inbox-backend.service /etc/systemd/system/
sudo sed -i "s|/path/to/inbox|$PWD|g" /etc/systemd/system/inbox-backend.service
# If node is under nvm, ensure the unit's Environment=PATH has the nvm bin dir
# (the committed unit ships with /home/pranav/.nvm/versions/node/v24.19.0/bin).
sudo systemctl daemon-reload
sudo systemctl enable --now inbox-backend
curl -s http://localhost:8787/api/health          # {"ok":true}
```

### 1.5 Bring up nginx + everything
```bash
bash deploy/start.sh              # builds dist/, installs nginx.conf on :8085,
                                  # auto-sudoes the nginx/systemd steps, health-checks
```

### 1.6 Verify
```bash
curl -s  http://127.0.0.1:8085/api/health          # {"ok":true}
curl -sI http://127.0.0.1:8085/ | head -1          # HTTP/1.1 200 (SPA)
curl -s  http://127.0.0.1:8085/ | head -3         # <!doctype html> ...
# WS upgrade through nginx:
curl -sI -H "Connection: Upgrade" -H "Upgrade: websocket" \
     -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: SGVsbG8=" \
     http://127.0.0.1:8085/api/health             # expect 101 / Upgrade header
sudo nginx -T | grep -A3 connection_upgrade      # map is live
```

### 1.7 Tunnel
Point cloudflared's origin at **`http://127.0.0.1:8085`** (NOT `:80`). Configure
Cloudflare Access with your email allowlist. Done.

---

## 2. Problems faced + solutions

| # | Symptom | Root cause | Fix |
|---|---|---|---|
| 1 | `Command 'pnpm' not found` | pnpm not installed | `corepack enable pnpm` (Node 24 ships corepack) |
| 2 | `Command 'nginx' not found` | nginx not installed | `sudo apt install -y nginx` |
| 3 | Coolify owns `:80`; `:443` is Tailscale | port conflict | Our nginx listens on loopback `127.0.0.1:8085` (`INBOX_LISTEN` override) |
| 4 | `systemctl is-system-running` → `degraded` | benign (fwupd, networkd-wait-online) | ignore |
| 5 | `ERR_PNPM_IGNORED_BUILDS: esbuild...` | pnpm v10+ blocks postinstall scripts by default | `pnpm approve-builds`; durable fix = `pnpm-workspace.yaml` with `allowBuilds` (pnpm v11 schema — the `pnpm` field in `package.json` is **ignored** in v11) |
| 6 | `./deploy/backend.sh: Permission denied` | exec bit lost in git (Windows `core.fileMode=false`) | `git update-index --chmod=+x deploy/backend.sh deploy/start.sh` |
| 7 | `start.sh: line 40: /etc/nginx/conf.d/inbox.conf: Permission denied` | ran as non-root; nginx config write needs root | `start.sh` now auto-sudoes the nginx + systemctl steps |
| 8 | `git pull` aborts: untracked `pnpm-workspace.yaml` would be overwritten | pnpm auto-generated it locally | `rm -f pnpm-workspace.yaml && git pull` (committed copy is authoritative) |
| 9 | systemd: `Unit ... has a bad unit file setting` | **two** issues: (a) `StartLimitIntervalSec/Burst` in `[Service]` (must be `[Unit]`), (b) **missing `ExecStart=`** (the fatal one) | moved StartLimit to `[Unit]`; added `ExecStart=/path/to/inbox/deploy/backend.sh` |
| 10 | `tsx: exec: node: not found` (crash loop) | node under nvm; systemd doesn't load shell profile | add nvm bin dir to unit's `Environment=PATH=...` |
| 11 | nginx `500` on `/` (but `/api` works) | `/home/pranav` was `750`; www-data can't traverse it → `stat()` EACCES → `try_files` redirection cycle | `chmod o+x /home/pranav` (751) — traverse bit only |
| 12 | `sudo` needs a password (no passwordless) | box config | run `sudo` interactively; for non-interactive reads, mount the log into a throwaway root container |

### The two "gotcha" fixes worth remembering
- **nginx WS `map`** (code fix, pre-VPS): `proxy_set_header Connection $connection_upgrade`
  needs a `map $http_upgrade $connection_upgrade { default upgrade; '' close; }`
  in the http context, or WebSocket chat dies while REST works.
- **systemd unit must have `ExecStart=`** — a service with no `ExecStart` is
  invalid ("Service has no ExecStart=... Refusing"). Easy to miss when the unit
  is written from scratch.

---

## 3. Files that matter

- `deploy/start.sh` — one-command bring-up (build, nginx, systemd, health). Auto-sudoes root steps.
- `deploy/backend.sh` — single-shot `exec ./node_modules/.bin/tsx server/index.ts` launcher (no while-loop; sources `deploy/.env`).
- `deploy/inbox-backend.service` — systemd unit (User, WorkingDirectory, ExecStart, nvm PATH, Restart=on-failure).
- `deploy/nginx.conf` — SPA + `/api` proxy + WS `map`; `__DIST__`/`__BACKEND__`/`__LISTEN__` substituted by start.sh.
- `deploy/.env` — gitignored secrets (`OLLAMA_API_KEY`).
- `pnpm-workspace.yaml` — pnpm v11 `allowBuilds` (esbuild/genai/protobufjs).

## 4. Ops cheat-sheet

```bash
systemctl status inbox-backend          # is the backend up?
journalctl -u inbox-backend -f          # follow backend output (like tmux attach)
sudo nginx -t && sudo nginx -s reload  # after editing nginx config
bash deploy/start.sh                   # re-run anything (idempotent)
```
