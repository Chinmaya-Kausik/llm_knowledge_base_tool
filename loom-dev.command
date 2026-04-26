#!/bin/bash
# Double-click this file to launch the Loom Dev UI (experimental, port 8421).

cd "$(dirname "$0")"

# Switch to dev branch
git checkout dev 2>/dev/null || echo "No dev branch yet — running from current branch"

# Read loom root from config, env var, or default
if [ -z "$LOOM_ROOT" ] && [ -f ~/.loom-app-config.json ]; then
  LOOM_ROOT=$(python3 -c "import json; print(json.load(open('$HOME/.loom-app-config.json')).get('loom_root',''))" 2>/dev/null)
fi
export LOOM_ROOT="${LOOM_ROOT:-$HOME/Documents/loom}"
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
