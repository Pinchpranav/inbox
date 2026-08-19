# Deployment Plan — 24/7 on the VPS (build-a8l)

**Status:** In progress (2026-08-19). This doc is the agreed plan for the
deployment bead `build-a8l`. The code it describes lives in `deploy/`. The
**discussion** on deployment direction is settled; this captures the "what we're
going to do." A later session will actually run it on the VPS.

Predecessor: `system 1.md` §11 (deployment intent). This doc makes the concrete
choices.

---

## 0. The target in one sentence

A **Hono backend** runs 24/7 under **systemd** (`deploy/inbox-backend.service`,
`Restart=on-failure` — self-healing + survives reboot), a **built Vue SPA**
(`dist/`) is served by **nginx** at `/`, nginx **reverse-proxies `/api`**
(HTTP + WebSocket) to the backend, and **cloudflared + Cloudflare Access** expose
it over HTTPS. One command brings the local-facing pieces up:
`bash deploy/start.sh`.

## 1. Topology (final)

```
Browser → Cloudflare Access (email allowlist) → cloudflared tunnel
    → nginx (loopback 127.0.0.1:8085)
        ├── /           serves built SPA (dist/)          ← pnpm build
        └── /api/*      reverse-proxy (HTTP + WS) → backend :8787
                                             ↑
                              systemd: deploy/backend.sh
                              (Restart=on-failure)
```

| Piece | How it runs | Who supervises |
|---|---|---|
| Frontend (`dist/`) | static files | nginx (system service) |
| `/api` proxy (REST + WS) | nginx rule | nginx |
| Backend (`npx tsx server/index.ts`) | `deploy/backend.sh` | **systemd** unit (`inbox-backend.service`) |
| Tunnel + TLS + access | cloudflared + Cloudflare Access | **owner (separate)** |

Because the frontend is a **build artifact** served by nginx, it is **not** a
running process — systemd only needs to keep the **backend** alive. (herdr is not
used for the 24/7 path; live output is followed with `journalctl -u
inbox-backend -f`.)

## 2. Decisions (locked)

1. **Build + serve** the frontend (`pnpm build` → `dist/`), not `pnpm dev`.
2. **nginx** serves `dist/` and reverse-proxies `/api` (HTTP + WS) → backend.
   One origin for the browser → no CORS.
3. **systemd** runs `deploy/backend.sh` as a unit (`inbox-backend.service`),
   kept alive 24/7, auto-starts on boot, sessions rebuilt from sqlite.
4. **Self-healing backend**: systemd `Restart=on-failure` restarts the server on
   any crash. `backend.sh` is a single-shot `exec` launcher (no `while true`
   loop — that loop would mask process status from systemd and fight
   `systemctl stop`).
5. **Secrets** in gitignored `deploy/.env` (`OLLAMA_API_KEY`, overrides),
   sourced by `deploy/start.sh` + `deploy/backend.sh`.
6. **No installs** in `start.sh` — nginx, systemd, cloudflared are assumed
   installed.
7. **`dist/` always rebuilt** by `start.sh` (never committed to git).
8. **Cloudflare tunnel + Access** are managed by the owner, **not** by
   `start.sh`. `start.sh` only *reports* whether cloudflared is running.

## 3. The one command — `deploy/start.sh`

Idempotent (safe to re-run; each step skips if already done):

```
1. deps   : pnpm install          (only if node_modules missing)
2. build  : pnpm build            → dist/
3. nginx  : install deploy/nginx.conf (sed-substitute paths) → nginx -t → reload
4. backend: `systemctl enable --now inbox-backend` (start.sh reports if the
   unit isn't installed; it does not reinstall paths)
5. cloud  : report cloudflared running/not (owner manages)
6. health : poll /api/health, report status
```

- `deploy/nginx.conf` — serve SPA at `/` (try_files → index.html) + proxy
  `/api/` to the backend with WS upgrade + long read/send timeouts.
- `deploy/backend.sh` — single-shot `exec ./node_modules/.bin/tsx
  server/index.ts` launcher (no while-loop; sources `deploy/.env`).
- `deploy/inbox-backend.service` — systemd unit (User=pranav,
  WorkingDirectory=repo, Restart=on-failure); paths need one-time sed for the VPS.

## 4. Pre-flight on the VPS (before / during the actual deploy)

- [ ] Backend boots (the `.inbox` mkdir fix is already shipped).
- [ ] `OLLAMA_API_KEY` set in `deploy/.env` (gitignored); the backend registers
      the ollama-cloud provider from this var directly (it does NOT rely on
      `~/.pi/agent`).
- [ ] Model: backend defaults to `ollama-cloud` / `deepseek-v4-flash:0731` in
      `server/piSession.ts`. (Note: no `:cloud` model id exists — that's the
      provider; flash options are `deepseek-v4-flash:0731` / `:preview`.)
      Making it env-configurable (`OLLAMA_MODEL`) is a **follow-up** change.
- [ ] nginx installed; `deploy/nginx.conf` works for the dist path AND the WS
      upgrade (the `map $http_upgrade $connection_upgrade` block must be present
      — without it `/api/chat` WebSocket fails while REST works).
- [ ] systemd unit installed: `deploy/inbox-backend.service` copied with real
      paths (`/etc/systemd/system/`), `daemon-reload`, `enable --now`, and
      `curl /api/health` green.
- [ ] cloudflared + Cloudflare Access: owner configures tunnel name, domain,
      email allowlist.

## 5. Acceptance criteria (from the bead) → how each is met

| Acceptance | How |
|---|---|
| Server runs 24/7 on the VPS behind nginx + cloudflared + Access | systemd unit + nginx + cloudflared/CF-Access |
| Survives restart (rebuilds from sqlite) | `stateStore.rebuildProjections()` on boot; systemd starts the unit on boot |
| Reachable from the browser | cloudflared tunnel → nginx → `/` (SPA) + `/api` (backend) |

## 6. Follow-ups (not this bead)

- Make the model env-configurable (`OLLAMA_MODEL`) in `server/piSession.ts`.
- (Sidebar / messages/inbox review is a separate bead: `build-2b4`.)
