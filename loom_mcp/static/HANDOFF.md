# Loom UI Phase 1 — Handoff to Claude Code (v2)

## What to do

On a fresh branch named `ui`:

1. Drop `style.ui-branch.css` into `loom_mcp/static/`.
2. Add a `<link>` tag to `loom_mcp/static/index.html` that loads it **after** the existing `style.css` link:
   ```html
   <link rel="stylesheet" href="/static/style.css">
   <link rel="stylesheet" href="/static/style.ui-branch.css">
   ```
3. Add a theme switcher:
   - A small toggle in the toolbar (sun/moon/book icon or a simple dropdown) that cycles / selects `data-theme` on `<html>` — values: `dark` (default), `light`, `paper`.
   - Persist the choice in `localStorage["loom-theme"]`.
   - On load: read localStorage; if absent, respect `prefers-color-scheme: light` as a hint (else default dark).
4. Create a convenience launcher: `loom-ui-development.command` at the **repo root**. See spec below.
5. **Do not touch** any other CSS, app.js logic, routes, or backend. Phase 1 is CSS + theme toggle + launcher only.

## `loom-ui-development.command` spec

A macOS double-clickable shell script that boots the Loom dev environment for this branch. Double-clicking should just work.

```bash
#!/usr/bin/env bash
set -euo pipefail

# Change to the repo root (directory containing this script).
cd "$(dirname "$0")"

# Ensure we're on the ui branch — warn but don't hard-fail if on another branch.
current=$(git rev-parse --abbrev-ref HEAD)
if [ "$current" != "ui" ]; then
  echo "Note: current branch is '$current', not 'ui'."
fi

# Activate venv if present (common layouts: .venv, venv).
if [ -f ".venv/bin/activate" ]; then
  source .venv/bin/activate
elif [ -f "venv/bin/activate" ]; then
  source venv/bin/activate
fi

# Start the Loom MCP server (adjust the command to match the project).
# Default: the repo exposes a `loom` entrypoint or `python -m loom_mcp`.
exec python -m loom_mcp
```

Then:
```bash
chmod +x loom-ui-development.command
```

If the real launch command differs (e.g. `uvicorn loom_mcp.app:app --reload --port 7777`), use that instead. Use whatever the repo's `Makefile` / `pyproject.toml` / README says is the dev command. The key is: **double-click opens Terminal and starts the server**.

## Rollback

The patch is pure additive CSS + a new file. To remove: delete the `<link>` line, delete `style.ui-branch.css`, delete the theme toggle code, delete `loom-ui-development.command`. Zero migration risk.

## Design notes (for context, not for implementation)

- **Three themes.** Dark is canonical (blue-undertone, Tokyo-Night-adjacent). Light is clean cool white. Paper is warm cream with a rust accent. All three share the same token names; only values differ.
- **Surface hierarchy.** Canvas (`--bg`) is the base; chrome (`--bg-surface`) sits above it; cards (`--bg-surface2`) sit one notch above chrome. Sunken (`--bg-sunken`) is deeper than canvas for inputs & code blocks.
- **Contrast is a budget.** Type colors and accents only surface on hover/focus — not at rest. This is intentional.
- **Semantic tokens** (`--danger`, `--diff-del-bg`, `--diff-add-bg`, etc.) are theme-aware — do not hardcode `oklch(...)` or hex values in selectors; reach for the tokens.
- **No behavior changes.** Everything is a visual re-skin. If something stops working, the patch did too much.

## Verifying

Before opening a PR, confirm in each theme:
- Toolbar + sidebar read as distinct bands from canvas.
- Cards are clearly cards (subtle border + slight elevation), opaque at rest.
- User chat messages have the `>` chevron + accent-soft wash + accent left rail.
- Tool-call blocks are dim at rest, expand to a sunken container when opened.
- Filename chips inside user messages read clearly (they use canvas bg, not the wash).
- Inputs (search, composer) read as recessed wells, no visible border at rest.
- Diffs (red = delete, green = add) are legible against the surrounding chat.
- Sidebar active row has an accent left rail + brighter text.

## After Phase 1 lands

Phase 2 (toolbar/chrome refinement), Phase 3 (command palette), Phase 4 (integrate theme toggle + palettes — already partly set up here), and Phase 5 (mobile/PWA) each ship in their own branch/PR.
