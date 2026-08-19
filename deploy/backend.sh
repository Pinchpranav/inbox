#!/usr/bin/env bash
# Self-healing wrapper for the inbox backend.
#
# Runs the Hono backend in a loop so a crash auto-restarts (simple "while true").
# Intended to run inside a herdr pane so it stays alive 24/7 and reattachable.
#
# Env: sources deploy/.env (gitignored) for OLLAMA_API_KEY and optional overrides.

set -u

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO" || exit 1

# Load secrets (optional — start.sh and the herdr pane both source the same file).
[ -f deploy/.env ] && { set -a; . deploy/.env; set +a; }

while true; do
  echo "[backend] starting at $(date '+%H:%M:%S')"
  npx tsx server/index.ts
  code=$?
  echo "[backend] exited (code $code) at $(date '+%H:%M:%S') — restarting in 2s"
  sleep 2
done
