#!/bin/bash
# Double-click this file to launch the Loom Workspace UI (stable, port 8420).

cd "$(dirname "$0")"

# Always run stable from main
git checkout main 2>/dev/null || true

# Read loom root from config, env var, or default
if [ -z "$LOOM_ROOT" ] && [ -f ~/.loom-app-config.json ]; then
  LOOM_ROOT=$(python3 -c "import json; print(json.load(open('$HOME/.loom-app-config.json')).get('loom_root',''))" 2>/dev/null)
fi
export LOOM_ROOT="${LOOM_ROOT:-$HOME/Documents/loom}"
export PATH="$HOME/.local/bin:$PATH"

echo "Starting Loom UI..."
echo "Branch: $(git branch --show-current)"
echo "Loom root: $LOOM_ROOT"
echo ""

# Open browser once server is ready
(while ! curl -s http://localhost:8420 > /dev/null 2>&1; do sleep 0.2; done; open "http://localhost:8420") &

uv run --extra web python -m loom_mcp.web
