#!/bin/bash
# Double-click this file to launch the Loom Dev UI (experimental, port 8421).

cd "$(dirname "$0")"

# Switch to dev branch
git checkout dev 2>/dev/null || echo "No dev branch yet — running from current branch"

# Dev always serves the demo loom
export LOOM_ROOT="$(pwd)/demo"
export LOOM_PORT=8421
export PATH="$HOME/.local/bin:$PATH"

echo "Starting Loom DEV UI..."
echo "Branch: $(git branch --show-current)"
echo "Loom root: $LOOM_ROOT"
echo "Port: $LOOM_PORT"
echo ""

# Open browser once server is ready
(while ! curl -s http://localhost:8421 > /dev/null 2>&1; do sleep 0.2; done; open "http://localhost:8421") &

uv run --extra web python -m loom_mcp.web
