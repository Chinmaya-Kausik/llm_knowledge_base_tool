# Loom UI Revised Implementation Plan (Final)

Files: `[css]` = style.ui-branch.css, `[html]` = index.html, `[js]` = app.js.

---

## Principles

- All card changes go in `createDocCard()` in app.js, NOT static HTML
- All sidebar changes go in `renderTree()` in app.js, NOT static HTML. `renderTreeItems()` is the Files view renderer — do NOT use it for sidebar changes.
- All chat features must work in BOTH the main panel (static HTML in index.html) AND floating panels (created by `createFloatingPanel()` / `connectPanelChat()` in app.js)
- CSS targets real class names: `.doc-card` not `.card`, `#chat-input-area` not `.chat-input-main`, `.doc-handle` not `.card-head`, `.tree-item` not `.sb-item`, `#edge-layer path` not `.edges path`, `#canvas-container` not `.canvas-wrap`, `.settings-menu` not `.sm-dropdown`, `.chat-activity-group` not `.tool-call`
- Context chip, model pills, pills row must be added to floating panel JS code too
- Don't remove working features (theme toggle, filter button) without replacing their functionality
- Use class-based selectors (not IDs) for any element that must appear in both main and floating panels
- Use `min-height` not `height` for dynamically populated containers
- Guard single-key shortcuts with `document.activeElement.tagName` checks
- Position fixed overlays relative to `var(--toolbar-height)`, not hardcoded pixel values
- Functions `openPalette()`, `closePalette()`, `initSegmentedControls()`, `initSettings()` do NOT exist yet — they must be CREATED, not just referenced. Plan items that wire to these functions require implementing the function first.

---

## Pre-Pass: Fix Existing Broken Commits

**Note**: These commit hashes may not exist on the current `dev` branch. Before executing each fix, verify the issue still exists in the current codebase. Skip any fix that is already resolved.

### 1. Commit `ebe7b80` — Context chip + model pills missing from floating panels

- `[js]` In `createFloatingPanel()`: add a `.chat-input-pills` div containing a `.chat-context-chip` element to the floating panel's `.fcp-input-area`
- `[js]` In `createFloatingPanel()`: wire context chip click handler per-panel (cycle `panel.contextLevel`, call `updateContextChip(panel)`)
- `[js]` Refactor `updateContextChip()` to accept a panel argument instead of using `document.getElementById('chat-context-chip')`
- `[js]` In floating panel send handler (~line 4132): add `<span class="model-pill">` to assistant message status bars, matching `sendChatMessage()` behavior

### 2. Commit `ca8ca48` — Pills row main-panel-only

- `[js]` In `createFloatingPanel()`: create `.chat-input-pills` div above `.fcp-input` textarea, same structure as main panel's `#chat-input-pills`
- `[css]` Change `#chat-input-pills` styles to class-based `.chat-input-pills` so both main and floating panels inherit

### 3. Commit `149f39b` — Flex override main-panel-only

- `[css]` Add `.fcp-input-area { flex-direction: column; }` to match `#chat-input-area` flex-direction override
- `[css]` Or: refactor both to use a shared class `.chat-input-area-layout` applied in both HTML and JS

### 4. Commit `accd3d0` — Enriched context chip markup only in main panel

- `[js]` In `createFloatingPanel()`: generate the same enriched chip markup (`.ctx-icon` SVG, `.ctx-label`, `.ctx-max`, separator) that index.html has for the main panel

### 5. Commit `242bf78` — Orphaned CSS from class renames

- `[css]` Verify whether orphaned `.tb-tabs`, `.tb-brand`, `.tb-chip` rules still exist in `style.ui-branch.css` before attempting cleanup (they may already be removed)
- `[css]` If present: change `html[data-density="compact"] .tb-tabs .view-tab` to `html[data-density="compact"] .tb-tab-group .view-tab`
- `[css]` If present: change `html[data-density="roomy"] .tb-tabs .view-tab` to `html[data-density="roomy"] .tb-tab-group .view-tab`
- `[css]` If present: delete orphaned `.tb-brand` rules (replaced by `.tb-brand-btn`)
- `[css]` If present: delete orphaned `.tb-chip` rules (replaced by `.tb-target`)
- `[css]` If present: delete orphaned `.tb-tabs` rules (replaced by `.tb-tab-group`)

### 6. Commit `2efb726` — Settings architecture ID reuse

- `[js]` Audit all references to `#btn-toolbar-menu` and confirm they expect the new settings-dropdown behavior
- `[js]` If any code path expected the old gear-opens-filters behavior, update to use `#btn-filters` instead

---

## Pass 1: Global CSS Foundation + Design Tokens

- `[css]` Add `font-feature-settings: "ss01", "cv11"` to `body`
- `[css]` Add scoped SVG block reset that does NOT break inline SVGs: `.doc-body svg, .markdown-body svg { display: block }` (scoped to rendered content areas only — toolbar, sidebar, and card icon SVGs remain inline)
- `[css]` Add global button reset: `button { font: inherit; background: none; border: none; cursor: pointer }`
- ~~`[css]` Add `body { overflow: hidden }`~~ — ALREADY EXISTS in style.css, skip
- ~~`[css]` Change scrollbar width from `5px` to `10px`~~ — ALREADY EXISTS in style.ui-branch.css, skip
- `[css]` Add scrollbar inset trick: `scrollbar { border: 2px solid var(--bg) }`
- `[css]` Define `:root { --density: 1; }` as a CSS custom property, then make toolbar height density-responsive: `--toolbar-height: calc(44px * var(--density))`
- `[css]` Define `--shadow-lg` variable (12px 40px heavy shadow)
- `[css]` Add `.zoom-val { min-width: 44px }` to prevent layout shift
- `[css]` Define `--font-read` variable, default to `var(--font-ui)` (GAP #1 from verification)
- `[css]` Add full type scale: `--fs-xl: 18px` from prototype
- `[css]` Add spacing variables: `--sp-5: 16px; --sp-6: 24px` from prototype
- `[css]` Add/verify Google Fonts import: Inter, IBM Plex Sans, JetBrains Mono, Newsreader in `<head>` (GAP #2 from verification) — `[html]` add `<link>` if not present
- `[css]` Define `--card-accent-mode` and `--canvas-bg` as explicit CSS custom properties on `:root` (GAP #3 from verification)
- `[css]` Define `--c-method` and `--c-signal` CSS variables for tool category dots with actual oklch values (GAP #10 from verification) — e.g. `--c-method: oklch(0.7 0.15 150); --c-signal: oklch(0.7 0.15 30)`

## Pass 2: Settings Dropdown Rewrite

- `[css]` Restyle the existing `.settings-menu` (NOT `.sm-dropdown` — use the real class name) with `position: fixed; top: calc(var(--toolbar-height) + 4px); right: 12px; width: 280px; z-index: 310`
- `[css]` Remove relative/wrapper positioning model on `.settings-menu`
- `[css]` Change container padding to `padding: 6px 0`
- `[css]` Set `.sm-item` layout to `display: grid; grid-template-columns: 22px 1fr auto`
- `[css]` Set `.sm-item` padding to `padding: 7px 14px`
- `[css]` Add `.sm-group-label` style: `font-size: 10px; text-transform: uppercase; letter-spacing: .08em; font-family: var(--font-mono); font-weight: 600`
- `[css]` Add `.sm-item:hover svg { color: var(--accent) }`
- `[css]` Add `.sm-ellipsis` style: `font-weight: 400; color: var(--text-muted)`
- `[html]` Incrementally restyle items inside existing `.settings-menu` — NOTE: `openPalette()`, `openPermissionsPanel()`, `openKeybindingPanel()` do NOT exist yet. Wire `onclick` handlers to stub functions that will be implemented in Pass 3 (appearance palette) and later passes.
- `[html]` Add `.sm-group-label` dividers (PALETTES group label)
- `[html]` Add `sm-ellipsis` `<span>` to items like "Appearance..." and "Model..."
- `[html]` Add `data-action` attributes on `.sm-item` elements for JS dispatch
- `[html]` Do NOT add "Account" or "Workspace" items (no backend support)
- `[html]` Keep Loom Root and Claude Auth fields in dropdown until full settings modal exists (Pass 21)
- `[js]` CREATE `initSettings()` function in app.js — wire settings dropdown `data-action` click handler for item dispatch
- `[js]` CREATE `openPalette(name)` and `closePalette()` functions — show/hide palette panels by name. Start with stub implementations that toggle visibility of `#palette-{name}` elements.

## Pass 3: Appearance Palette Rewrite

- **Note**: No appearance palette exists yet. This pass CREATES it from scratch.
- `[html]` Add `#palette-appearance` element to index.html — `position: fixed` floating panel
- `[css]` Use `top: calc(var(--toolbar-height) + 8px)` not hardcoded `top: 60px`
- `[css]` Add `box-shadow: var(--shadow-lg)`; `border-radius: var(--r-lg)`
- `[css]` Set body to `max-height: 70vh; overflow-y: auto`
- `[css]` Add row separator: `border-bottom: 1px dotted var(--border-soft)` on each setting row
- `[css]` Fix eyebrow: `font-size: 9.5px; letter-spacing: .1em`
- `[css]` Fix label `font-weight: 600`
- `[css]` Add sunken footer: `background: var(--bg-sunken)` with "Esc to dismiss" + "Open in full settings ->"
- `[html]` Add Palette row (Slate/Blue) as segmented control with `data-setting="palette"`
- `[html]` Add Theme row (Light/Dark/Paper) as segmented control with `data-setting="theme"`
- `[html]` Add Typography row (Mixed/Mono) as segmented control with `data-setting="typography"`
- `[html]` Add Density and Card Accent and Canvas BG rows
- `[html]` Add Loom Threads row: segmented Off/On with `data-setting="threads"`
- `[html]` Add Accent Hue slider: `<input type="range">` controlling `--accent-hue`
- `[html]` Do NOT add Canvas Layers toggles (Heat, Reading trail, Auto-cluster, Constellation) — features don't exist yet, defer to Pass 17
- `[html]` Do NOT add Pinboard mode toggle — feature doesn't exist yet, defer to Pass 15
- `[html]` Add "Open in full settings ->" link in footer
- `[js]` CREATE `initSegmentedControls()` function — discovers all `[data-setting]` segmented controls, wires click handlers, reads/writes localStorage, sets `data-*` attributes on `<html>`
- `[js]` Wire Palette segmented control: set `data-palette` on `<html>`, persist to localStorage — via `initSegmentedControls()`
- `[js]` Wire Typography segmented control: set `data-typography` on `<html>`, persist — via `initSegmentedControls()`
- `[js]` Wire Loom Threads segmented control: set `data-threads` on `<html>`, persist — via `initSegmentedControls()`
- `[js]` Wire accent hue slider: dynamically recalculate `--accent`, `--accent-soft`, `--glow` from oklch hue — new function `onAccentHueChange()` in app.js
- `[js]` Handle attribute removal edge cases: `theme="dark"` removes attr, `density="std"` removes, `palette="slate"` removes
- `[js]` Add `Cmd+Shift+A` keyboard shortcut to open Appearance palette (GAP #11 from verification)

## Pass 4: Segmented Controls

- `[css]` Change `.seg` buttons to `flex: 1` (equal width)
- `[css]` Change font-size to `var(--fs-xs)` (11px)
- `[css]` Change `.seg` container `border-radius` to `var(--r-sm)` (4px)
- `[css]` Change button padding to `4px 6px`
- `[css]` Change button border-radius to `3px`
- `[css]` Add `.seg.small` variant: `button { padding: 2px 6px; font-size: 10px }`

## Pass 5: Palette Variants (Blue + Paper themes)

- `[css]` **Note**: The current dark theme already uses hue 258 and chroma .035-.045, which matches the prototype's "blue" palette. The default dark theme IS effectively the blue palette. Therefore: define `html[data-palette="slate"]` as the variant (lower chroma, neutral hue), and treat the current dark theme as the blue baseline. Only add `html[data-palette="slate"]` overrides: lower surface chroma (.015-.025), hue shift to neutral (265+), accent chroma 0.12, muted semantic colors.
- `[css]` Add `html[data-type="mono"]` override: set `--font-ui` and `--font-read` to `var(--font-mono)` (Mono Typography variant — the CSS rule that the segmented control in Pass 3 wires to)
- `[css]` Add `html[data-theme="paper"]` overrides: `--font-read: 'Newsreader', serif`, warm-tinted shadows `rgba(60,40,20,...)` (GAP #5 from verification)
- `[css]` Paper theme sets `--font-read` override to Newsreader. ALSO: update `.doc-body` to use `font-family: var(--font-read)` instead of `var(--font-ui)` so the `--font-read` variable actually takes effect.

## Pass 6: Card Accent + Card Polish

- `[css]` Replace existing `border-left` accent on `.doc-card` (NOT `.doc-handle` — the accent is on `.doc-card` itself per style.ui-branch.css lines 280-307) with `box-shadow: inset 3px 0 0 var(--c-*)` (no layout shift)
- `[css]` Apply accent only on `.doc-card:hover` and `.doc-card.focused`, not at rest
- `[css]` Gate behind `html[data-accent="border"]` — only show inset shadow in border mode. Coexist with existing `html[data-accent="dot"]` rules (style.ui-branch.css lines 325-330).
- `[css]` In dot mode (`html[data-accent="dot"]`): suppress inset box-shadow, show `.card-dot` (already rendered by `createDocCard()`)
- `[css]` In flat mode (`html[data-accent="flat"]`): suppress both inset shadow and dot
- ~~`[css]` `.card-filename` italic style~~ — ALREADY EXISTS in style.ui-branch.css line 350, skip
- `[css]` `.doc-card.folder::before` mask icon using CSS `mask-image` with folder SVG data URI — verify targets `.doc-card` not `.card`
- `[css]` Do NOT add `.card.hero { width: 300px }` — conflicts with d3-zoom canvas scaling
- ~~`[css]` User message CLI-style: `.chat-msg-user { border-radius: 0 var(--r-md) var(--r-md) 0; }`, `gap: 0`~~ — ALREADY EXISTS in style.ui-branch.css lines 462-491, skip
- `[js]` Remove `.card-filename` subtitle from `createDocCard()` — user decided subtitles are noise when they duplicate the card body heading
- `[css]` Reduce `.doc-handle` padding back to original compact size (remove the `9px 12px 10px` override, let it inherit from base style.css)

## Pass 7: Toolbar Cleanup

- `[html]` Do NOT remove theme dropdown — keep JS logic, redirect theme switching through Appearance palette segmented control which already exists
- `[html]` Do NOT remove filter funnel button `#btn-filters` — it controls essential canvas filters with real checkbox wiring to `loadGraph()`
- `[css]` If theme button is visually hidden: `#theme-dropdown-wrap { display: none }` while keeping JS intact
- ~~`[css]` Change brand text color from `--accent` to `--text-bright` on `.tb-brand-btn`~~ — ALREADY EXISTS in style.ui-branch.css line 599, skip
- `[css]` Add `.tb-brand-btn { letter-spacing: -0.01em }`
- ~~`[css]` Change `.tb-target` to `color: var(--text); border: none`~~ — ALREADY EXISTS in style.ui-branch.css lines 605-621, skip
- `[css]` Change toolbar icon buttons to 28x28 — target the actual button elements used in the toolbar (audit existing selectors; `.tb-icon-btn` may not exist yet, target the real elements or define the class and apply it)
- `[html]` Change search input placeholder to `"Search pages, files, chats..."`
- `[css]` Change `.tb-divider` to `height: 18px; margin: 0 var(--sp-1)`

## Pass 8: Sidebar Structure

- `[js]` Modify `renderTree()` in app.js (line ~2639, the sidebar tree renderer — NOT `renderTreeItems()` which is the Files view): add `WORKSPACE` section header as first child — uppercase, collapsible with chevron SVG
- `[css]` Style `.sb-section-header`: `font-size: 10px; text-transform: uppercase; letter-spacing: .08em; font-family: var(--font-mono)`
- `[js]` Modify `renderTree()` in app.js: replace text icons with SVG icons (folder, circle, document, clock) on the generated tree items
- `[js]` Modify `renderTree()`: add `.sb-count` spans with item counts, right-aligned, on the generated items
- `[css]` Style `.sb-count`: `margin-left: auto; font-family: var(--font-mono); font-size: 10px`
- `[css]` Add `.sb-section { margin-top: var(--sp-3) }`
- `[js]` Track recently opened files in app.js state (array of last 3-5, update on file open in the click handlers within `renderTree()` output and `createDocCard()` — there is no `selectNode()` function)
- `[js]` Add Recent section in `renderTree()`: clock SVG icon, last 3-5 opened files
- `[css]` Set nested items: `.tree-item.nested { padding-left: 26px }` (use real `.tree-item` class, NOT prototype `.sb-item`)

## Pass 9: Breadcrumb Polish

- `[css]` Set `min-height: 30px` (not fixed `height`) on `#breadcrumb-bar` to allow content overflow
- `[css]` Set `background: var(--bg)` (canvas bg, not surface)
- `[css]` Add `border-bottom: 1px solid var(--border-soft)`
- `[css]` Set `.breadcrumb-stats`: `font-size: 10px; color: var(--text-dim); font-family: var(--font-mono)`
- `[js]` In `updateBreadcrumb()` (singular, line ~1820 — the canvas breadcrumb function): dynamically populate page count from `cardElements.size`, edge count, zoom level (GAP #7 from verification) — already partially done in commit `a92eba4`, verify completeness

## Pass 10: Chat Header + Input (Multi-Panel)

- `[js]` Modify `createPanelHeader()` in app.js: add subtitle element `.chat-subtitle` (mono 10px dim) showing `"model . N msgs . page name"`
- `[js]` Update subtitle dynamically per-panel: read model from panel state `panel.model` — guard against `null` default (display "Claude" or similar fallback when `panel.model` is null), count messages from panel's message container, get active page name from panel context
- `[js]` In `initChat()`: style the EXISTING `#chat-send` button as 36x36 accent-filled with SVG arrow icon (do NOT create a new button — the main panel send button already exists in static HTML). In `createFloatingPanel()`: create send button matching this style.
- `[css]` Style `#chat-send, .fcp-send` (the real selectors for main and floating panel send buttons): `width: 36px; height: 36px; background: var(--accent); border-radius: var(--r-sm)`. Plan uses `.chat-send-btn` as an ADDITIONAL shared class applied to both elements.
- `[css]` Add send hover: `filter: brightness(1.1)`
- `[js]` Update textarea placeholder in BOTH places: main panel placeholder is set in HTML (index.html line ~374) and floating panel placeholder is set in JS (line ~3993). Change both to `"Message Claude... Cmd+Return to send"`
- `[css]` Set textarea (`.fcp-input` AND `#chat-input`): `min-height: 36px; max-height: 160px; resize: none`
- `[css]` Set textarea bg: `background: var(--bg-sunken)` at rest, `var(--bg)` on `:focus`
- `[js]` In both main panel AND `createFloatingPanel()`: change context chip icon from gear to clock SVG
- `[js]` In both main panel AND `createFloatingPanel()`: add `.chat-context-pill` per-file pills — NOTE: requires backend `/api/context-manifest` endpoint to list files; defer pill rendering until endpoint exists; add empty container now
- `[css]` Style `.chat-context-pill`: inline pill, mono 10px, bg-surface2, rounded, `.pill-x` close on hover

## Pass 11: Tool Call Styling

- `[js]` Modify existing `toolIcon()` function in app.js (line ~5094) to return correct SVGs: Read=document, Grep=search, Edit=pencil, Bash=terminal, Write=page
- `[css]` Style `.chat-activity-group .chat-activity-header` (NOT `<details>` / `.tool-call summary` — the real app uses `.chat-activity-group` with `.chat-activity-header` and `.chat-activity-body`, expandable via JS click): `opacity: .75` at rest, `opacity: 1` on `:hover` and when expanded
- `[css]` Add `.tool-time`: `margin-left: auto; font-size: 10px; font-family: var(--font-mono)`
- `[css]` Style expanded `.chat-activity-group.open` (or equivalent expanded state): `background: var(--bg-sunken); border-color: var(--border-soft)`

## Pass 12: Model Pill + Handoff Marker (Multi-Panel)

- `[js]` `panel.model` is already tracked in `ChatPanel` state — update from WebSocket response metadata
- `[js]` Render model pill inline in assistant message after first paragraph — in BOTH `sendChatMessage()` (main panel, line ~4976) AND floating panel send handler. Note: assistant content is streamed incrementally via WebSocket; inserting a pill "after the first paragraph" requires post-processing the assembled HTML (e.g., on stream completion or after first `</p>` detected). Consider simpler approach: append pill to the message status bar initially, migrate to inline later.
- `[css]` Add `.model-pill` styles from scratch (no existing CSS): `display: inline-block; font-size: 10px; font-family: var(--font-mono); padding: 1px 6px; border-radius: var(--r-sm); vertical-align: 2px`
- `[css]` Add model colors for `qwen` and `gpt` (replace `codex`)
- `[js]` Remove model pill from status bar area (main panel `sendChatMessage()` and `sendQueuedMessage()` line ~5044) — only after inline rendering is working
- `[js]` Add `.handoff-marker` element between messages when `panel.model` changes — in BOTH main and floating panel message rendering
- `[css]` Style `.handoff-marker`: centered text-with-lines, pair of model pills with horizontal rule

## Pass 13: Context Chip + Popover (Multi-Panel)

- `[css]` Add `.ctx-bar` inline mini progress bar: `width: 28px; height: 3px; background: var(--bg-sunken); border-radius: 2px`
- `[css]` Add `.ctx-bar::after` fill via `--ctx-pct`: `width: calc(var(--ctx-pct) * 1%)`
- `[css]` Add context chip color coding by `data-usage` attr: green/amber/red
- `[js]` In BOTH main panel AND `createFloatingPanel()`: add popover container anchored to context chip
- `[css]` Position popover: use `position: fixed` and calculate from `getBoundingClientRect()` in JS (not `position: absolute`) to handle all panel modes
- `[js]` Scope picker: 3-column grid with radio buttons (page / folder / global — NOT 4 levels, the real app only supports 3 context levels per line ~4499) — updates `panel.contextLevel` and triggers re-estimation
- `[css]` Style scope picker: `display: grid; grid-template-columns: repeat(3, 1fr)`
- `[css]` Style radio buttons: 12px circle, accent fill when selected
- `[js]` File list: defer until backend `/api/context-manifest` endpoint exists — render placeholder "Context details coming soon"
- `[css]` Style `.ctx-group-label`: `font-size: 9px; text-transform: uppercase; letter-spacing: .08em; font-family: var(--font-mono)`
- `[css]` Style `.ctx-file` grid: `display: grid; grid-template-columns: 1fr auto 14px`
- `[css]` Style drop button: red on `:hover`
- `[css]` Sunken footer: `background: var(--bg-sunken)` with usage bar + headroom text
- `[js]` Toggle popover on context chip click — per-panel, not global
- ~~`[js]` Expose `window.__renderPins` global for external pinboard re-render triggers~~ — Pinboard feature does not exist yet, defer to Pass 15

## Pass 14: Misc CSS + Wiring

- `[css]` Add `.perm-head` shield-checkmark SVG icon in permission prompt header
- `[css]` Standardize diff line rendering: `.d-line` with `padding: 1px 10px`, `.d-del` / `.d-add` with oklch alpha backgrounds
- `[css]` Constellation canvas bg (`html[data-canvas="constellation"] #infinite-canvas`): nebula radial-gradient pair + `::before` pseudo-element with star-point gradients (GAP #6 from verification)
- `[css]` Constellation edge glow: `html[data-canvas="constellation"] #edge-layer path` (NOT `.edges path` — use the real `#edge-layer path` selector) with oklch alpha stroke and `filter: drop-shadow()` (GAP #8 from verification)
- `[css]` `#canvas-container` structure (NOT `.canvas-wrap` — use the real ID): add comment/placeholder for machinery strip insertion point (GAP #13 from verification)

---

## Passes 15-21 (deferred, carried forward)

### Pass 15: Pinboard CSS (all modes)

- `[css]` Strip mode: `.pinboard { position: absolute; top: 12px; right: 12px; width: 168px; max-height: calc(100% - 24px); pointer-events: none; z-index: 20 }`
- `[css]` Strip children `pointer-events: auto`
- `[css]` Style `.pin-card`: border, background, radius, hover lift
- `[css]` Style `.pin-title`: mono 10.5px; `.pin-path`: mono 8.5px dim, `.away` accent-colored
- `[css]` Style `.pin-x`: visible on `.pin-card:hover` only
- `[css]` Style `.pin-more`: dashed border, "+N more" overflow
- `[css]` `@keyframes pin-flash` (900ms glow on navigate)
- `[css]` Rail mode: `width: 22px`, vertical text, counter-rotation, hover expand
- `[css]` Double-class specificity `.pinboard.pinboard[data-mode="rail"]`
- `[css]` Sidebar mode: `.pinboard { display: none }`, `.sb-pins` in sidebar
- `[css]` Style `.sb-pin` items: dot, name, path, hover close
- `[js]` Expose `window.__renderPins` global for external pinboard re-render triggers (moved from Pass 13)
- **Prerequisite**: Build Pinboard JS feature first (data model, pin/unpin actions, persistence) before this CSS is useful

### Pass 16: Thread Lines CSS + JS

- `[css]` `.threads` container: `position: absolute; z-index: 85; pointer-events: none`
- `[css]` `.threads path`: dashed stroke, opacity 0
- `[css]` `@keyframes thread-in`: opacity animation
- `[css]` `html[data-threads="on"] .threads path { animation: thread-in .3s .1s forwards }`
- `[js]` Render SVG paths from EACH active chat panel (main + floating) to its context card
- `[js]` Account for `zoomBehavior.transform` (accessible at module scope, line ~1136) to convert between screen coords (panel position) and canvas coords (card position)
- `[js]` Handle multiple simultaneous thread lines for multiple panels

### Pass 17 (deferred): Canvas Overlay Layers

- `[css]` Heat Aura: `box-shadow` + `color-mix` glow on cards via `data-heat`
- `[css]` `.doc-card.dimmed { opacity: .38 }` for clustering (use real `.doc-card` class, not `.card`)
- `[css]` Cluster transition with overshoot bezier
- `[js]` Reading history, trail SVG, auto-cluster (simple + weighted), constellation, collision relaxation
- `[js]` Single-key shortcuts H/T/C/S/G — guard with `document.activeElement.tagName` check (no firing in text inputs)
- **After this pass**: add Canvas Layers toggles to Appearance palette (deferred from Pass 3)

### Pass 18 (deferred): Machinery Strip

- `[css]` `.machinery-strip`: 26px height, sunken bg, mono 10.5px
- `[css]` `.m-group`, `.m-dot` heartbeat, `.m-log` ellipsis
- `[html]` Add strip element between `#breadcrumb-bar` and `#canvas-container` (these are the real element names in the flex column)
- `[js]` Populate with MCP server status, last tool call, active process

### Pass 19 (deferred): Model & Agent Palette

- `[html]` `#palette-model` floating panel: `position: fixed; top: calc(var(--toolbar-height) + 8px); right: 16px; width: 280px; z-index: 300`
- `[js]` Query available models from backend — do NOT hardcode model names (note: no `/api/models` endpoint exists yet, backend work required)
- `[js]` Per-panel model/agent selection updates WebSocket connection parameters (sends via `panel.model` field in the chat protocol)
- `[html]` Temperature slider, reasoning depth, system prompt preset, stream toggle
- `[css]` `.sub-note` style
- `[js]` `Cmd+Shift+M` shortcut

### Pass 20 (deferred): Tools & Permissions Palette

- `[html]` `#palette-tools` floating panel: `position: fixed; top: calc(var(--toolbar-height) + 8px)`
- `[html]` `.tools-list` with `.tool-row` items and checkbox toggles
- `[css]` Colored dots per tool category using `--c-method` and `--c-signal` (defined with actual values in Pass 1)
- `[html]` Approval Mode segmented: Auto / Ask / Strict
- `[js]` `Cmd+Shift+T` shortcut

### Pass 21 (deferred): Full Settings Modal

- `[css]` `.fs-overlay`: fixed inset, oklch backdrop, blur
- `[css]` `.fs-panel`: `width: min(880px, 92vw)`, grid with 200px sidebar
- `[css]` Nav, nav-item active, body-head, row layout styles
- `[html]` Settings nav: Account, Workspace, Storage, Appearance, Model, Tools, Memory, Indexing, Keyboard, Integrations, Privacy, About
- `[js]` Wire "Open in full settings" from Appearance palette footer
- `[js]` Wire `Cmd+,` to open full settings modal
- `[html]` Move Loom Root, Claude Auth, font size, code font size fields here (removed from dropdown in this pass, not earlier)

---

## Part 2: Post-Prototype Features

Approved features beyond the prototype annotation scope. Each gets its own implementation pass when prioritized.

### Command Palette (Cmd+Shift+P)

- Raycast-style fuzzy-match search across pages, files, commands, chat sessions, settings
- Prefix filters: `>` commands, `@` pages, `#` tags
- Floats centered, z-index above everything
- Keyboard-navigable: arrows, Enter, Esc

### Agent Activity System

- Visual quote-trail lines: thin animated line from card to chat on read, chat to card on write
- Folder dots pulse (1.5s decay) when inner file touched
- Single toggle in Appearance palette

### Time Machine

- Git-based diff viewer scoped to wiki pages
- Clock icon in card header
- Timeline of commits, inline diff rendering
- Read-only, no revert

### Search Within Chat

- Scope search to current/specific chat session
- "Search in chat" option or filter prefix
- Highlight matching messages, scroll to them

### Right-Click Context Menu Refinement

- Consistent styling, group labels, keyboard shortcut hints
- Submenu support for card actions (pin, open in panel, copy link, history)

### Canvas File Drag/Move

- Drag files from sidebar/cards onto folder headers
- Workshop-style "move out" UX
- Visual drop target highlighting

### Redirect-as-Hover

- Handle in chat gutter (assistant message left edge)
- Hover shows referenced card/page
- Click navigates to card on canvas

### Logo

- Interwoven "L" wordmark / "The Crossing" favicon
- SVG, all sizes
- Replace current brand mark in toolbar

### Responsive CSS / Mobile Layout

- Bottom nav on small screens, 44px touch targets
- Collapsible sidebar overlay, full-width chat
- PWA manifest + service worker
- Breakpoints: 768px, 480px
