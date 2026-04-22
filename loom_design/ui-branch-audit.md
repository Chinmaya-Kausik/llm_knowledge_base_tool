# UI Branch Audit Report

Audited: 2026-04-21
Scope: All changes on the `ui` branch — app.js (~8700 lines), style.ui-branch.css (~2000 lines), index.html, web.py, chat.py

---

## Critical Bugs

### Python crash: None.startswith("vm:") in global context
`chat.py` line 438: When `context_level == "global"` and `page_path is None`, execution reaches `page_path.startswith("vm:")` which raises `AttributeError`. The guard at line 434 only returns early for non-global levels.

### Auth bypass: 11 API calls use bare fetch() instead of authFetch()
These will all fail on remote backends with token auth:
- `fetch('/api/children/...')` in `drillInto` (line 1800)
- `fetch('/api/pages/bulk'...)` in `initGraphView` (line 2804)
- `fetch('/api/children/...')` in `initSidebar` (line 2875)
- `fetch('/api/page/...')`, `fetch('/api/mkdir')`, `fetch('/api/delete')` in action menu (lines 3827, 3844, 3871)
- `fetch('/api/chat/append')` (line 4335)

### Stale DOM references in selectedCards
`selectedCards` set holds card DOM elements but is never cleared on canvas navigation (`renderCurrentLevel` calls `world.innerHTML = ''` and `cardElements.clear()`). Can cause memory leaks and errors.

### Session ID desync on dock transfer
When docking a floating panel to main, `sessionStorage` isn't updated with the new session ID. Page refresh loads the wrong session.

---

## Architecture Issues

### Fragile state sync (25+ globals)
The chat system uses a global-variable proxy pattern where ~25 globals (`chatWs`, `chatSessionId`, `chatGenerating`, etc.) must be manually synced to/from `ChatPanel` instances via `syncFromPanel`/`syncToPanel`. The floating panel event handler saves and restores all globals for EACH event. Any new state variable must be added to BOTH sync functions plus the save/restore blocks in `processQueue`.

### Z-index inflation
`topZIndex` only increases, never resets. After ~200 `bringToFront` calls, the "fullpage threshold" of 400 is meaningless. The `!important` on every z-index assignment makes CSS classes useless for z-ordering.

### Two theme systems
Inline script in index.html and app.js full settings both manage themes through a fragile `window.applyTheme` bridge.

---

## Dead Code

| Code | Location | Reason |
|------|----------|--------|
| `_location_block()` | chat.py lines 288-336 | Replaced by `_location_block_adaptive`, never called |
| `computeLayoutCola` | app.js lines 2133-2168 | d3-force always available, CoLa path never reached |
| `vmFilesTreeData` | app.js line 366 | Set but never independently read |
| `toggleChat()` / `chatDockMode` | app.js line 5164 | Replaced by universal panel header |
| Theme dropdown HTML + JS | index.html lines 99-114 | Hidden with `display: none` but still shipped |
| Rename context menu action | app.js line 517-524 | Logs to console, does nothing |
| `fullpageReturnView` | app.js line 2541 | Only meaningful for 'files' view, no-op for 'graph' |

---

## Inconsistencies

### Fullpage state checked two ways
Most code uses `expandedCard` (JS variable), but context popover at line 5022 still uses `document.getElementById('fullpage-overlay')`.

### statusBar.className assigned twice
Lines 5637-5638: First assignment immediately overwritten.

### isCodeFile check duplicated
Inline check at line 2517 vs proper `isCodeFile()` function at line 7257. Different file lists.

### fetch vs authFetch
See critical bugs section above.

---

## CSS Issues

### !important abuse for z-index
`bringToFront` uses `!important` on every z-index set. Makes CSS classes meaningless for z-ordering.

### .chat-activity-group defined twice
Line 558 and line 1597 with different radius variables and border.

### Responsive !important on floating panels
Line 1926: `!important` on width/left fights with JS drag/resize inline styles.

---

## Error Handling Gaps

### API methods don't check r.ok
All 20+ methods in the `api` object call `.then(r => r.json())` without checking response status. 404/500 responses silently treated as valid data.

### 11 silent empty catches
`.catch(() => {})` at lines 2896, 3159, 4336, 4347, 7330, 7585, 7816, 7971, 7976, 8044, 8315.

### VM push/pull no error handling
Lines 788-803: No try/catch around awaited API calls. User sees stale "Pushing..." message on failure.

### fitAddon could be null
Line 4928: `ResizeObserver` uses `fitAddon.fit()` but `fitAddon` could be null if `XFitAddon` was falsy.

---

## Performance Concerns

| Issue | Location | Impact |
|-------|----------|--------|
| `nodeById` is O(n) | line 1126 | Called in hot paths, should use Map |
| `updateEdges` rebuilds all SVG | lines 1742-1786 | Every drag/resize creates GC pressure |
| `setFocusedItem` scans full DOM | line 1098 | Runs on every click |
| Click listeners never removed | lines 4129, 7298, 7314 | Accumulate over panel lifecycle |
| `refreshFileTree` = 3 sequential API calls | lines 3011-3041 | Called after every file op |
| `forceRectCollide` is O(n²) | lines 1898-1920 | 100 nodes = 1.5M iterations |

---

## Console.log Statements (22 total)

Most impactful:
- Line 171/173: Logs every API graph/tree call
- Line 6045: Logs every non-text chat event
- Lines 3899-3929: focusChat debug logs
- Lines 4025-4028: dockPanel debug logs
- Lines 8586-8647: Cmd+J/Cmd+/ debug logs

---

## Suggested Tests

### Unit Tests
1. `matchesBinding(e, action)` — all flag combinations
2. `nodeById(id)` / `getChildIds(parentPath)` — with mock graphData
3. `getSmartContextDefault()` — root/subfolder/file
4. `formatToolDesc(tool, input)` — each tool branch
5. `escapeHtml(str)` — XSS edge cases
6. `computeLayoutGrid(nodes, saved)` — 0, 1, many nodes
7. `sortItems(items)` — all sort modes
8. `build_system_prompt` (Python) — all levels, None page_path
9. `_location_block_adaptive` (Python) — all levels + vm: + None crash
10. `_map_tool_to_category` (Python) — all tool names

### Integration Tests
1. Z-index stacking: fullpage + floating chat + Escape
2. Cmd+J cycling with 0/1/2/3 panels
3. Context scope picker locking after first message
4. Dock/undock transitions
5. Service worker cache-then-network
6. Sidebar resize persistence across reload
7. Settings font picker → CSS variable update
8. Remote backend auth on all API calls
9. Canvas drill-in state restoration
10. Multi-select card delete
