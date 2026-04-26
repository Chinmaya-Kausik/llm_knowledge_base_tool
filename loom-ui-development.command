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
if [ -z "$LOOM_ROOT" ] && [ -f ~/.loom-app-config.json ]; then
  LOOM_ROOT=$(python3 -c "import json; print(json.load(open('$HOME/.loom-app-config.json')).get('loom_root',''))" 2>/dev/null)
fi
export LOOM_ROOT="${LOOM_ROOT:-$HOME/Documents/loom}"

# Check if port is already in use
if lsof -i ":$LOOM_PORT" -P -sTCP:LISTEN >/dev/null 2>&1; then
  echo "ERROR: Port $LOOM_PORT is already in use!"
  echo "Kill the existing process or set a different port: LOOM_PORT=8422 $0"
  lsof -i ":$LOOM_PORT" -P -sTCP:LISTEN
  read -p "Kill it and continue? [y/N] " yn
  if [ "$yn" = "y" ] || [ "$yn" = "Y" ]; then
    lsof -ti ":$LOOM_PORT" | xargs kill 2>/dev/null
    sleep 1
  else
    exit 1
  fi
fi

# Clear ALL caches to ensure fresh code
echo "[debug] Clearing caches..."
find loom_mcp -name '__pycache__' -type d -exec rm -rf {} + 2>/dev/null || true
# Also clear uv's cached editable install
find .venv -name 'loom_mcp' -path '*/site-packages/*' -type d -exec rm -rf {} + 2>/dev/null || true
find .venv -name 'loom*.dist-info' -path '*/site-packages/*' -type d -exec rm -rf {} + 2>/dev/null || true
echo "[debug] Branch: $current"
echo "[debug] web.py mtime: $(stat -f '%Sm' loom_mcp/web.py 2>/dev/null || echo 'unknown')"
echo "[debug] app.js mtime: $(stat -f '%Sm' loom_mcp/static/app.js 2>/dev/null || echo 'unknown')"
echo "[debug] style.ui-branch.css mtime: $(stat -f '%Sm' loom_mcp/static/style.ui-branch.css 2>/dev/null || echo 'unknown')"

echo "Starting Loom UI dev server on port $LOOM_PORT (branch: $current)..."

# Wait for server to be ready, then open browser
(
  for i in $(seq 1 30); do
    if curl -s -o /dev/null "http://localhost:$LOOM_PORT/api/ping" 2>/dev/null; then
      # Verify the server is serving fresh files
      echo "[debug] Server ready. Checking app.js version..."
      served_mtime=$(curl -sI "http://localhost:$LOOM_PORT/static/app.js" 2>/dev/null | grep -i last-modified | head -1)
      echo "[debug] Served app.js: $served_mtime"
      open "http://localhost:$LOOM_PORT"
      exit 0
    fi
    sleep 0.5
  done
  echo "Server did not start in 15s — open http://localhost:$LOOM_PORT manually"
) &

exec uv run --extra web python -m loom_mcp.web
