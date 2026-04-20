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
echo "Open http://localhost:$LOOM_PORT in your browser"
open "http://localhost:$LOOM_PORT" &

exec uv run --extra web python -m loom_mcp.web
