#!/usr/bin/env bash
set -euo pipefail

# Change to the repo root (directory containing this script).
cd "$(dirname "$0")"

# Note which branch we're on.
current=$(git rev-parse --abbrev-ref HEAD)
if [ "$current" != "ui" ]; then
  echo "Note: current branch is '$current', not 'ui'."
fi

# Start the Loom dev server on port 8421 using the demo loom.
exec uv run --extra web python -m loom_mcp.web
