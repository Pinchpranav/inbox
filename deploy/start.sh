#!/usr/bin/env bash
# inbox — one command to bring the app up on the VPS.
#
#   bash deploy/start.sh
#
# Steps (idempotent — safe to re-run):
#   1. install deps (only if missing)      pnpm install
#   2. build the frontend                  pnpm build   -> dist/
#   3. install + reload nginx               serve dist/ + proxy /api -> backend
#   4. ensure the backend is up             in a herdr pane (self-healing)
#   5. ensure the cloudflared tunnel        (tunnel + Cloudflare Access)
#   6. health checks + status report
#
# Assumes nginx, herdr and cloudflared are ALREADY INSTALLED (system services).
# Secrets live in deploy/.env (gitignored). Run as a user with nginx + herdr rights.

set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"

# 0. Load secrets (gitignored deploy/.env) — optional.
[ -f deploy/.env ] && { set -a; . deploy/.env; set +a; }

BACKEND="${INBOX_BACKEND:-localhost:8787}"
HEALTH="http://$BACKEND/api/health"

echo "==>[1/6] deps (if missing)"
[ -d node_modules ] || pnpm install

echo "==>[2/6] building frontend -> dist/"
pnpm build

echo "==>[3/6] configuring nginx (serve dist/ + proxy /api -> $BACKEND)"
DIST_PATH="$REPO/dist"
sed "s|__DIST__|$DIST_PATH|g; s|__BACKEND__|$BACKEND|g" deploy/nginx.conf > /etc/nginx/conf.d/inbox.conf
nginx -t
nginx -s reload

echo "==>[4/6] ensuring the backend runs in a herdr pane"
ensure_backend() {
  # Already up? Nothing to do.
  if curl -sf "$HEALTH" >/dev/null 2>&1; then
    echo "  backend already healthy at $HEALTH — skipping"
    return 0
  fi
  if ! command -v herdr >/dev/null 2>&1; then
    echo "  ! herdr not found — start it manually:" >&2
    echo "    cd $REPO && ./deploy/backend.sh   (in a herdr pane)" >&2
    return 1
  fi

  # Reuse an existing 'inbox' workspace, else create one (idempotent).
  local ws pane
  ws="$(herdr workspace list 2>/dev/null \
        | grep -o '"label":"inbox"[^}]*"workspace_id":"[a-z0-9]*"' \
        | sed -E 's/.*"workspace_id":"([a-z0-9]*)".*/\1/' | head -1)"
  if [ -z "$ws" ]; then
    ws="$(herdr workspace create --cwd "$REPO" --label inbox 2>/dev/null \
          | grep -o '"workspace_id":"[a-z0-9]*"' \
          | sed -E 's/.*"workspace_id":"([a-z0-9]*)".*/\1/' | head -1)"
  fi
  [ -z "$ws" ] && ws="w1"

  # Root pane of that workspace (fall back to <ws>:p1).
  pane="$(herdr pane list --workspace "$ws" 2>/dev/null \
          | grep -o '"pane_id":"[a-z0-9:]*"' \
          | sed -E 's/.*"pane_id":"([a-z0-9:]*)".*/\1/' | head -1)"
  [ -z "$pane" ] && pane="${ws}:p1"

  echo "  using herdr workspace '$ws' pane '$pane'"
  herdr pane run "$pane" "cd $REPO && ./deploy/backend.sh" >/dev/null 2>&1 || {
    echo "  ! could not launch backend pane — verify with: herdr pane list" >&2
    return 1
  }
}
ensure_backend || echo "  (backend not auto-started — see note above)"

echo "==>[5/6] checking cloudflared tunnel status (you manage the tunnel/access)"
if command -v cloudflared >/dev/null 2>&1; then
  if pgrep -f "cloudflared tunnel" >/dev/null 2>&1; then
    echo "  cloudflared tunnel: RUNNING"
  else
    echo "  cloudflared tunnel: NOT running (start it yourself when ready)"
  fi
else
  echo "  cloudflared not found — install it when you set up the tunnel"
fi

echo "==>[6/6] health checks"
for _ in $(seq 1 30); do
  if curl -sf "$HEALTH" >/dev/null 2>&1; then echo "  backend OK  $HEALTH"; break; fi
  sleep 1
done
curl -sf "$HEALTH" >/dev/null 2>&1 || echo "  ! backend did not come up — check the herdr pane"

echo
echo "Done. Frontend on http://<host>/ (nginx, same-origin) — backend via /api -> $BACKEND."
echo "Reattach to the backend pane anytime:  herdr"
