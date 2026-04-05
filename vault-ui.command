#!/bin/bash
# Double-click this file to launch the Vault Knowledge Base UI.

cd "$(dirname "$0")"

# Read vault root from config, env var, or default
if [ -z "$VAULT_ROOT" ] && [ -f ~/.vault-app-config.json ]; then
  VAULT_ROOT=$(python3 -c "import json; print(json.load(open('$HOME/.vault-app-config.json')).get('vault_root',''))" 2>/dev/null)
fi
export VAULT_ROOT="${VAULT_ROOT:-$HOME/Documents/vault}"
export PATH="$HOME/.local/bin:$PATH"

echo "Starting Vault UI..."
echo "Vault root: $VAULT_ROOT"
echo ""

# Open browser once server is ready
(while ! curl -s http://localhost:8420 > /dev/null 2>&1; do sleep 0.2; done; open "http://localhost:8420") &

uv run --frozen --extra web python -m vault_mcp.web
