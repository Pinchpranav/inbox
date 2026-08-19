# Deployment Plan — 24/7 on the VPS (build-a8l)

**Status:** In progress (2026-08-19). This doc is the agreed plan for the
deployment bead `build-a8l`. The code it describes lives in `deploy/`. The
**discussion** on deployment direction is settled; this captures the "what we're
going to do." A later session will actually run it on the VPS.

Predecessor: `system 1.md` §11 (deployment intent). This doc makes the concrete
choices.

---

## 0. The target in one sentence

A **Hono backend** runs 24/7 in a **herdr** pane (self-healing), a **built Vue
SPA** (`dist/`) is served by **nginx** at `/`, nginx **reverse-proxies `/api`**
(HTTP + WebSocket) to the backend, and **cloudflared + Cloudflare Access** expose
it over HTTPS. One command brings the local-facing pieces up:
`bash deploy/start.sh`.

## 1. Topology (final)

```
Browser → Cloudflare Access (email allowlist) → cloudflared tunnel
    → nginx (:80/:443)
        ├── /           serves built SPA (dist/)          ← pnpm build
        └── /api/*      reverse-proxy (HTTP + WS) → backend :8787
                                             ↑
                                    herdr pane: deploy/backend.sh
                                    (self-healing while loop)
```

| Piece | How it runs | Who supervises |
|---|---|---|
| Frontend (`dist/`) | static files | nginx (system service) |
| `/api` proxy (REST + WS) | nginx rule | nginx |
| Backend (`npx tsx server/index.ts`) | `deploy/backend.sh` | **herdr** pane (the one real always-on process) |
| Tunnel + TLS + access | cloudflared + Cloudflare Access | **owner (separate)** |

Because the frontend is a **build artifact** served by nginx, it is **not** a
running process — herdr only needs to keep the **backend** alive.

## 2. Decisions (locked)

1. **Build + serve** the frontend (`pnpm build` → `dist/`), not `pnpm dev`.
2. **nginx** serves `dist/` and reverse-proxies `/api` (HTTP + WS) → backend.
   One origin for the browser → no CORS.
3. **herdr** runs the backend as a pane, kept alive 24/7, reattachable
   (`herdr` to attach), sessions survive restarts.
4. **Self-healing backend**: `deploy/backend.sh` wraps the server in a
   `while true` loop so a crash auto-restarts (simple, per owner).
5. **Secrets** in gitignored `deploy/.env` (`OLLAMA_API_KEY`, overrides),
   sourced by `deploy/start.sh` + `deploy/backend.sh`.
6. **No installs** in `start.sh` — nginx, herdr, cloudflared are assumed
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
4. backend: reuse the 'inbox' herdr workspace (create if absent) → pane run deploy/backend.sh
5. cloud  : report cloudflared running/not (owner manages)
6. health : poll /api/health, report status
```

- `deploy/nginx.conf` — serve SPA at `/` (try_files → index.html) + proxy
  `/api/` to the backend with WS upgrade + long read/send timeouts.
- `deploy/backend.sh` — `while true` loop running `npx tsx server/index.ts`.

## 4. Pre-flight on the VPS (before / during the actual deploy)

- [ ] Backend boots (the `.inbox` mkdir fix is already shipped).
- [ ] `OLLAMA_API_KEY` set in `deploy/.env`; the run-as user's `~/.pi/agent` has
      ollama-cloud configured.
- [ ] Confirm the model: the backend currently **hardcodes** `ollama-cloud` /
      `gemma4:31b` in `server/piSession.ts`. Decide the model for the VPS;
      making it env-configurable (`OLLAMA_MODEL`) is a **follow-up** change (owner
      chose to do it after the deploy).
- [ ] herdr installed + running as a service; verify `herdr workspace create /
      pane list / pane run` against the binary in PATH (the exact extraction in
      `start.sh` was verified against a preview build on the dev box).
- [ ] nginx installed; `deploy/nginx.conf` works for the dist path.
- [ ] cloudflared + Cloudflare Access: owner configures tunnel name, domain,
      email allowlist.

## 5. Acceptance criteria (from the bead) → how each is met

| Acceptance | How |
|---|---|
| Server runs 24/7 on the VPS behind nginx + cloudflared + Access | herdr pane + nginx + cloudflared/CF-Access |
| Survives restart (rebuilds from sqlite) | `stateStore.rebuildProjections()` on boot; herdr keeps the pane |
| Reachable from the browser | cloudflared tunnel → nginx → `/` (SPA) + `/api` (backend) |

## 6. Follow-ups (not this bead)

- Make the model env-configurable (`OLLAMA_MODEL`) in `server/piSession.ts`.
- (Sidebar / messages/inbox review is a separate bead: `build-2b4`.)
