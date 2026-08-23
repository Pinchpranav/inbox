#!/usr/bin/env bash
# inbox backend — single-shot launcher for the Hono backend.
#
# Runs under systemd (deploy/inbox-backend.service), which owns supervision:
#   - Restart=on-failure  -> auto-restart on any abnormal exit (self-healing)
#   - multi-user.target   -> starts on boot (survives reboots)
#
# This script does NOT wrap the server in a while-loop. Under systemd that loop
# is redundant AND harmful: it would mask the process status from systemd and
# keep respawning the backend after `systemctl stop`.
#
# We use `exec` so the node process replaces this shell; signals (SIGTERM from
# systemctl stop, etc.) then go straight to the backend, which shuts down its
# sessions + sqlite store gracefully (see server/index.ts SIGTERM handler).

set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO" || exit 1

# Load secrets (gitignored deploy/.env: COMMANDCODE_API_KEY + optional overrides).
[ -f deploy/.env ] && { set -a; . deploy/.env; set +a; }

echo "[inbox-backend] starting at $(date '+%Y-%m-%d %H:%M:%S') (pid $$)"
# Use the repo-local tsx bin (no dependence on npx/PATH inside systemd).
exec ./node_modules/.bin/tsx server/index.ts
