#!/usr/bin/env bash
set -euo pipefail

# GUI apps don't inherit shell PATH — add common install locations
export PATH="$HOME/.local/bin:$HOME/.cargo/bin:/usr/local/bin:/opt/homebrew/bin:$PATH"

# Change to the repo root (directory containing this script).
cd "$(dirname "$0")"

# Note which branch we're on.
current=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")
if [ "$current" != "ui" ]; then
  echo "Note: current branch is '$current', not 'ui'."
fi

export LOOM_PORT="${LOOM_PORT:-8421}"
export LOOM_ROOT="${LOOM_ROOT:-$(pwd)/demo}"

echo "Starting Loom UI dev server on port $LOOM_PORT..."

# Wait for server to be ready, then open browser
(
  for i in $(seq 1 30); do
    if curl -s -o /dev/null "http://localhost:$LOOM_PORT/api/ping" 2>/dev/null; then
      open "http://localhost:$LOOM_PORT"
      exit 0
    fi
    sleep 0.5
  done
  echo "Server did not start in 15s — open http://localhost:$LOOM_PORT manually"
) &

exec uv run --extra web python -m loom_mcp.web
