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

echo "Starting Loom UI dev server..."
echo "Open http://localhost:8420 in your browser"
open "http://localhost:8420" &

exec uv run --extra web python -m loom_mcp.web
