#!/bin/bash
# Double-click this file to launch the Vault Knowledge Base UI.
# It starts the server and opens your browser to http://localhost:8420

cd "$(dirname "$0")"

export VAULT_ROOT="${VAULT_ROOT:-$(pwd)}"
export PATH="$HOME/.local/bin:$PATH"

echo "Starting Vault UI..."
echo "Vault root: $VAULT_ROOT"
echo ""

# Open browser once server is ready (poll instead of fixed sleep)
(while ! curl -s http://localhost:8420 > /dev/null 2>&1; do sleep 0.2; done; open "http://localhost:8420") &

uv run --frozen --extra web python -m vault_mcp.web
