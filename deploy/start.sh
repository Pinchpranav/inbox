#!/usr/bin/env bash
# inbox — one command to bring the app up on the VPS.
#
#   bash deploy/start.sh
#
# Steps (idempotent — safe to re-run):
#   1. install deps (only if missing)      pnpm install
#   2. build the frontend                  pnpm build   -> dist/
#   3. install + reload nginx               serve dist/ + proxy /api -> backend
#   4. ensure the backend is up             systemd service (deploy/backend.sh)
#   5. ensure the cloudflared tunnel        (tunnel + Cloudflare Access)
#   6. health checks + status report
#
# Assumes nginx and cloudflared are ALREADY INSTALLED (system services), and that
# the inbox backend systemd unit (deploy/inbox-backend.service) is installed once.
# Secrets live in deploy/.env (gitignored). Root is required only for the nginx +.
# systemd steps; this script auto-elevates via sudo when run as a non-root user.

set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"

# 0. Load secrets (gitignored deploy/.env) — optional.
[ -f deploy/.env ] && { set -a; . deploy/.env; set +a; }

# Root is needed for writing nginx config, nginx -t/reload, and systemctl.
# Elevate just those commands (build/install stay as the invoking user).
SUDO=""
if [ "$(id -u)" -ne 0 ] && command -v sudo >/dev/null 2>&1; then
  SUDO="sudo"
fi

BACKEND="${INBOX_BACKEND:-localhost:8787}"
# Our nginx listens on a free loopback port (not :80, which Coolify owns here).
# Override with INBOX_LISTEN in deploy/.env if 8085 is taken on the box.
LISTEN="${INBOX_LISTEN:-127.0.0.1:8085}"
HEALTH="http://$BACKEND/api/health"

echo "==>[1/6] deps (if missing)"
[ -d node_modules ] || pnpm install

echo "==>[2/6] building frontend -> dist/"
pnpm build

echo "==>[3/6] configuring nginx (serve dist/ + proxy /api -> $BACKEND on $LISTEN)"
DIST_PATH="$REPO/dist"
$SUDO sh -c "sed \"s|__DIST__|$DIST_PATH|g; s|__BACKEND__|$BACKEND|g; s|__LISTEN__|$LISTEN|g\" deploy/nginx.conf > /etc/nginx/conf.d/inbox.conf"
$SUDO nginx -t
if $SUDO systemctl is-active --quiet nginx 2>/dev/null; then
  $SUDO nginx -s reload
else
  echo "  nginx not running — starting it"
  $SUDO systemctl start nginx \
    || echo "  ! could not start nginx — the apt default site binds :80 (Coolify owns it). Remove it and retry:" >&2
  $SUDO rm -f /etc/nginx/sites-enabled/default
  $SUDO systemctl enable nginx
  $SUDO systemctl start nginx || echo "  ! nginx still not starting — check: journalctl -u nginx" >&2
fi

echo "==>[4/6] ensuring the backend systemd service is running"
SERVICE="inbox-backend.service"
if command -v systemctl >/dev/null 2>&1; then
  if $SUDO systemctl is-active --quiet "$SERVICE" 2>/dev/null; then
    echo "  $SERVICE already active — skipping"
  elif $SUDO systemctl enable --now "$SERVICE" 2>/dev/null; then
    echo "  enabled + started $SERVICE"
  else
    echo "  ! could not start $SERVICE — is deploy/inbox-backend.service installed?" >&2
    echo "    sudo cp deploy/inbox-backend.service /etc/systemd/system/" >&2
    echo "    sudo sed -i 's|/path/to/inbox|$REPO|g' /etc/systemd/system/inbox-backend.service" >&2
    echo "    sudo systemctl daemon-reload && sudo systemctl enable --now inbox-backend" >&2
  fi
else
  echo "  ! systemctl not available — start the backend manually:" >&2
  echo "    cd $REPO && ./deploy/backend.sh" >&2
fi

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
curl -sf "$HEALTH" >/dev/null 2>&1 || echo "  ! backend did not come up — check: journalctl -u inbox-backend -f"

echo
echo "Done. Frontend on http://<host>/ (nginx, same-origin) — backend via /api -> $BACKEND."
echo "Follow backend output:  journalctl -u inbox-backend -f"
