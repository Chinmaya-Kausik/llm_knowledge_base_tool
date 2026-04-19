# Loom UI Phase 2 — Toolbar & Chrome Refinement

## Branch

`ui-phase-2-toolbar` (branched off `ui`, assumes Phase 1 has landed).

## Goal

Replace the existing toolbar with a structured three-cluster layout (navigation / context / tools) that has room for the command palette, theme toggle, and endpoint status. Zero functional regressions — every existing toolbar action keeps working.

## What to build

### 1. New toolbar structure

Replace the current toolbar's markup with three clusters separated by thin vertical dividers:

**Left cluster — navigation & identity**
- Brand mark: a small SVG "loom" glyph (3 horizontal + 2 vertical lines, woven). 22×22px. Use `currentColor` + `--accent`.
- Brand wordmark: "Loom" at `--fs-lg`, weight 600.
- Target chip: `● Local ▾` — shows current backend endpoint. The dot is a status indicator, dropdown lists available backends. See "Endpoint status" below.
- Sidebar-collapse button moves HERE when the sidebar is collapsed (it's currently a floating button).

**Center cluster — view tabs**
- Grouped tab container with sunken background (`--bg-sunken`) and 2px padding.
- Tabs: Canvas / Files / Tags / Health — each with a small icon.
- Active tab: elevated chip (`--bg-surface2` + `--shadow`) + bright text.
- Inactive: muted text, transparent bg.

**Center-right — search**
- Input with leading search icon.
- Trailing `⌘F` kbd glyph that hides on focus.
- `max-width: 360px`, flexes to fill.
- Uses `--bg-sunken` bg, no border at rest, accent border on focus.

**Right cluster — tools**
- `+` new chat button.
- `⌘P` command palette trigger (icon only for now — palette itself comes in Phase 3). Just needs a keyboard listener that logs "palette coming soon" until Phase 3.
- Theme toggle — dropdown showing three rows with preview swatches (dark / light / paper). Value persists in `localStorage["loom-theme"]`. Also respects `prefers-color-scheme` on first load.
- Settings gear (preserves current behavior).
- Tweaks gear (if present in current app; otherwise skip).

Between each cluster: a 1px × 20px vertical divider at `--border-soft`.

### 2. Endpoint status on the target chip

The status dot on the target chip indicates current endpoint health:

- **Local** (green, `--c-summary`) — you're pointed at a local backend and it's reachable.
- **Tailscale** (cyan, `--c-project`) — you're on a non-local tailnet endpoint and it's reachable.
- **VM** (orange, `--c-index`) — cloud VM endpoint, reachable.
- **Offline** (red, `--danger`) — endpoint not reachable.
- **Pending** (dim, pulsing) — switching endpoints / initial load.

Implementation: poll `/api/status` (or whatever existing health endpoint is) every 10s. Update the chip's `data-endpoint-state` attribute; CSS handles the color.

If no such endpoint exists yet, stub it: the chip shows "Local / green" always. Add a `TODO: wire to /api/status` comment. Do not build the backend health check as part of this phase.

### 3. Integrate the Phase 1 theme toggle

Phase 1 already has a temporary theme toggle somewhere (or should — if it doesn't, add one now). Move/promote it into the right cluster as a dropdown. Each row in the dropdown:

- 16×16px preview swatch (showing the theme's canvas + surface + accent as three stripes)
- Theme name
- Check mark on the currently-selected theme

### 4. Styling

Append all toolbar styles to `style.ui-branch.css`. Reuse existing tokens. No new tokens needed except possibly `--toolbar-height: 44px` for reuse.

## Constraints

- **Zero functional regressions.** Every action that works today works after this patch. Events, keyboard shortcuts, click handlers — identical.
- **Build additively.** Don't delete the old toolbar until the new one is wired up and tested. Strategy:
  1. Add the new toolbar markup alongside the old (both rendered).
  2. Wire up all event handlers to the new toolbar.
  3. Hide the old toolbar with `display:none`.
  4. Remove the old toolbar markup in a separate commit.
- **No new dependencies.** No icon libraries. Hand-roll the 5–8 SVGs needed inline.
- **No backend changes.** If endpoint status requires an endpoint that doesn't exist, stub it.
- **Keyboard shortcuts preserved.** `⌘F` focuses search. If `⌘F` didn't do this before, it does now.

## Files

- `loom_mcp/static/index.html` — toolbar markup replacement.
- `loom_mcp/static/style.ui-branch.css` — toolbar styles appended.
- `loom_mcp/static/app.js` — theme toggle dropdown logic, endpoint status poll, search focus handler.

## Verification

Before opening a PR, confirm:

- All three themes render the toolbar cleanly.
- Target chip status dot matches actual endpoint state (or stub is visible + marked TODO).
- Active view tab is visually distinct.
- Sidebar collapse still works; when collapsed, the expand button appears in the toolbar's left cluster.
- `⌘F` focuses search.
- Theme dropdown swatches accurately preview each theme.
- No console errors.
- The old toolbar is gone (not just hidden — removed).

## Out of scope for Phase 2

- Command palette behavior (Phase 3 — just add the trigger icon now).
- Any backend work (Phase 2 is pure frontend).
- Mobile layout for the toolbar (Phase 5a handles responsive).
- Reading mode / per-page theme override (Phase 4).

## After Phase 2 lands

Phase 3 (command palette) is unblocked. You can also start on independent explorations like canvas layer-toggles (heat aura, thread lines, auto-cluster) in parallel — those don't depend on toolbar work.
