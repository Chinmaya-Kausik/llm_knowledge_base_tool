# Mobile UI Research: Converting Desktop Canvas App to Mobile

Research date: 2026-04-20
Context: Loom is a knowledge base with infinite canvas, file browser, AI chat, and settings panels.

---

## 1. How Apps Like Notion, Obsidian, Figma, Miro Handle Mobile vs Desktop

### Obsidian
- Desktop: left sidebar (file tree), right sidebar (backlinks/outline), center editor — all panels simultaneously visible.
- Mobile: single-panel view, sidebars become edge-swipe drawers. Swipe right from left edge opens left sidebar; swipe left from right edge opens right sidebar.
- Bottom toolbar replaces top toolbar for thumb access.
- The core mental model (files + editor) maps well to mobile; it's the same data, different chrome.
- Users complained that swipe-to-open-sidebar is too sensitive — fires accidentally. Lesson: edge swipe threshold matters (typically 20–30px from edge, with velocity check).
- Recent updates (2025–2026): command palette surfaced on mobile, swipe between tabs on the bottom toolbar.

### Figma / Miro on Mobile
- Both limit canvas editing on mobile — primarily view and comment mode.
- The full tri-panel desktop layout (layers/tools/canvas/inspector) is too dense for phones.
- Figma: viewer app only on mobile. Full editor requires iPad.
- Miro: mobile lets you browse, comment, make small moves. Core creation stays desktop.
- Key decision for Loom: is the canvas read-only on mobile, or do you need full edit? Read-only + navigation first is the lower-risk path.

### Discord (Desktop vs Mobile — Most Analogous to Loom's Chat + Sidebar)
- Desktop: persistent tri-column (servers | channels | messages + members).
- Mobile 2023 redesign: moved to bottom tab bar with 4 tabs (Home, Mentions, Search, Profile). Each tab is a full-screen stack navigator.
- Home tab: swipe right to reveal server list (drawer pattern), swipe left inside a channel to reveal member list.
- DMs accessible via Messages icon in Home tab.
- Key insight: Discord collapsed their 3-column hierarchy into tabs + swipe layers. The persistent sidebar became a swipe drawer.

### Slack
- Desktop: left sidebar always visible (workspaces, channels, DMs).
- Mobile: bottom tab bar with Home, DMs, Activity, Search. Home tab contains the channel/DM list as a scrollable list.
- Swipe-to-reply on messages (right-to-left swipe on a message item).

---

## 2. Desktop Toolbar + Sidebar + Canvas Layout → Mobile Patterns

The canonical conversion:

```
Desktop:                          Mobile:
[Sidebar][Canvas][Right Panel]  → [Canvas full screen]
[Top Toolbar]                     [Bottom Tab Bar]
                                  [Sidebar → swipe drawer from left edge]
                                  [Right Panel → bottom sheet or swipe from right]
                                  [Toolbar → floating action button or context toolbar above keyboard]
```

**Specific techniques:**

- Sidebar becomes a **left drawer**: translates in from left on swipe or tap. Overlays content with a dark scrim behind it. Dismiss by tapping scrim or swiping left.
- Right panel becomes a **bottom sheet**: slides up from bottom. Can be half-height (peek) or full-height.
- Top toolbar collapses: either hide entirely and show only on tap, or move critical actions to bottom where thumbs reach.
- Canvas: full-bleed, no persistent chrome stealing space.

---

## 3. Bottom Tab Bar vs Hamburger Menu vs Swipe Navigation

### Research Verdict: Bottom Tab Bar Wins for Primary Navigation

- NN/Group: hamburger menus hide navigation, reducing feature discovery and engagement.
- Booking.com A/B test: visible tabs → 25–50% higher engagement vs hamburger.
- Hidden hamburger navigation: used in 57% of cases. Visible tab bar: 86% of cases (1.5x more).

### Rules:
- 3–5 items max in tab bar (hard constraint — no labels beyond 5).
- Use tab bar for **top-level** destinations only. Not for actions or secondary pages.
- For more than 5 top-level items: move secondary items into a "More" overflow or a drawer.

### For Loom specifically (4 destinations: Canvas, Files, Chat, Settings):
- 4 tabs = perfect fit for bottom tab bar.
- No hamburger needed at this size.

### Swipe Navigation
- Obsidian uses swipe from screen edges for sidebars (not tabs).
- Discord uses swipe within panels (not for top-level navigation).
- Swipe between tabs (like iOS tab bar) works well for flat structures but causes confusion in hierarchical ones.
- Recommendation: use edge-swipe for drawer open/close only. Do not use swipe-left/right for tab switching — conflicts with canvas pan.

---

## 4. Chat Apps (Slack, Discord, iMessage) Mobile Layout Patterns

### Common patterns across all three:
- Message list: full-screen, scrolls to bottom on new message.
- Input bar: `position: sticky; bottom: 0` — moves with keyboard.
- Keyboard behavior: on iOS, keyboard pushes content up via `interactive-widget: resizes-content` in viewport meta or JavaScript `visualViewport` resize events.
- Swipe left on message item → reveal quick action (reply, react).
- Long press on message → context menu (reaction picker + action list, presented as a bottom sheet or popover anchored to the message).

### iOS keyboard handling (critical quirk):
- On iOS Safari/PWA, the keyboard does NOT resize the viewport by default — it overlays it.
- Fix: listen to `window.visualViewport.addEventListener('resize', ...)` and adjust layout manually.
- Or: use `height: 100dvh` (dynamic viewport height, supported iOS 15.4+) which automatically accounts for the keyboard.

```css
/* Modern approach */
.chat-container {
  height: 100dvh; /* dynamic viewport height, shrinks with keyboard */
}

/* Fallback for older iOS */
.chat-container {
  height: 100vh;
  height: 100dvh;
}
```

---

## 5. Note-Taking Apps: Mobile Reading/Browsing Patterns

### Obsidian mobile browsing:
- File list is a full-page drawer, not a persistent sidebar.
- Tap a file → it slides into view over the file list (push navigation).
- Bottom toolbar: back button, file list button, quick-open search, new note.
- Swipe back gesture (from left edge) to navigate up the breadcrumb.

### Notion mobile browsing:
- Hierarchical pages list as full-screen list.
- Push navigation into pages: each page is a full-screen view.
- Breadcrumb at top shows path.
- Bottom action bar appears when text is selected.

### Pattern: Push Navigation for Deep Hierarchies
- Don't show file tree + content simultaneously on phone.
- Use push navigation (like UINavigationController on iOS): list → detail → sub-detail.
- Back swipe from left edge to go up.

---

## 6. Touch Interaction Patterns

### Touch target sizing
- Minimum 44×44px (Apple HIG) or 48×48dp (Material Design).
- Ensure 8px+ spacing between adjacent targets.
- Use CSS `padding` to extend touch area beyond visual bounds — don't rely on visual size.

```css
.icon-button {
  min-width: 44px;
  min-height: 44px;
  padding: 10px;
  /* visual icon can be smaller */
}
```

### Long press → context menu
- Use `pointer-events` + a timer (400–500ms) in JavaScript.
- Must cancel on move (>4px threshold) to not interfere with scroll.
- Present result as bottom sheet with actions, not as a floating dropdown (dropdowns get clipped or mispositioned near edges).

```javascript
let longPressTimer;
element.addEventListener('pointerdown', (e) => {
  longPressTimer = setTimeout(() => showContextSheet(e), 450);
});
element.addEventListener('pointermove', (e) => {
  if (Math.hypot(e.movementX, e.movementY) > 4) clearTimeout(longPressTimer);
});
element.addEventListener('pointerup', () => clearTimeout(longPressTimer));
element.addEventListener('pointercancel', () => clearTimeout(longPressTimer));
```

### Swipe-to-reveal (list items)
- Translate item left on swipe to reveal action buttons underneath.
- Track `touchstart` → `touchmove` delta. Commit at >50% of action width or fast fling.
- Reset on tap elsewhere.
- Use `touch-action: pan-y` on the list so vertical scroll isn't blocked.

### Pinch-to-zoom on canvas
- `wheel` event fires for both trackpad scroll AND pinch. Distinguish by checking `e.ctrlKey` (browser sets this on pinch).
- Trackpad pinch: `deltaY` is small (0.5–3). Mouse wheel with Ctrl: `deltaY` is large (100–120). Scale accordingly.
- For touch: use `pointermove` with two pointers, compute distance delta between frames.

```javascript
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  if (e.ctrlKey) {
    // Pinch or Ctrl+scroll = zoom
    const scaleFactor = e.deltaY > 50 ? 0.9 : e.deltaY < -50 ? 1.1 : 1 - e.deltaY * 0.01;
    applyZoom(scaleFactor, e.clientX, e.clientY);
  } else {
    // Two-finger scroll = pan
    applyPan(-e.deltaX, -e.deltaY);
  }
}, { passive: false });
```

### CSS `touch-action` — critical for canvas
- `touch-action: none` on the canvas element: take full control of all touch input.
- `touch-action: pan-y` on scrollable lists: allow native vertical scroll, intercept horizontal.
- `touch-action: manipulation` on buttons: remove 300ms tap delay without breaking scroll.

---

## 7. PWA-Specific Mobile Patterns

### Safe area insets (notch, home indicator)
- Requires two things: (1) viewport meta with `viewport-fit=cover`, (2) CSS `env()` variables.

```html
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
```

```css
/* Bottom tab bar example */
.tab-bar {
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  height: calc(60px + env(safe-area-inset-bottom));
  padding-bottom: env(safe-area-inset-bottom);
  background: var(--surface);
}

/* Content must not be hidden behind tab bar */
.main-content {
  padding-bottom: calc(60px + env(safe-area-inset-bottom));
}

/* Left/right safe areas for landscape */
.sidebar {
  padding-left: env(safe-area-inset-left);
}
```

### iOS-specific quirks
- `env(safe-area-inset-bottom)` is 34px on iPhone with home indicator in PWA mode, but 0px in Safari browser.
- Use `display-mode: standalone` media query to apply PWA-specific styles:

```css
@media (display-mode: standalone) {
  .tab-bar {
    padding-bottom: env(safe-area-inset-bottom);
  }
}
```

- Keyboard overlays content on iOS (does not resize viewport). Use `window.visualViewport` to detect.
- `overscroll-behavior: none` on body prevents rubber-band bounce but Safari support is inconsistent. More reliable: `position: fixed` on the root element for app-like behavior (no body scroll at all, manage scrolling in child containers).

### Status bar in PWA
```html
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
```
`black-translucent` lets your content extend behind the status bar but requires you to handle `safe-area-inset-top` in CSS.

### Overscroll control
```css
html, body {
  overscroll-behavior: none; /* prevents pull-to-refresh and bounce at top */
}

.scrollable-list {
  overscroll-behavior: contain; /* bounce within this container, don't propagate */
}
```
Note: iOS Safari does not fully honor `overscroll-behavior`. For canvas apps, better to use `position: fixed` root and handle all scroll in JS.

### 100dvh instead of 100vh
```css
.app-shell {
  height: 100dvh; /* dynamic viewport height: adjusts for browser chrome */
  /* Safari ≥15.4, Chrome ≥108, Firefox ≥101 */
}
```

---

## 8. Modals / Dropdowns / Popovers on Mobile

### Decision tree:
- **Simple selection (< 5 options)**: action sheet (bottom sheet with list of buttons). iOS-native feel.
- **Contextual menu on long press**: bottom sheet anchored to bottom, not to the element (avoids overflow/clipping).
- **Form input / content creation**: full-screen modal (push onto navigation stack).
- **Informational overlay / quick settings**: half-height bottom sheet with drag handle.
- **Never use floating dropdowns on mobile**: they clip at screen edges, are hard to dismiss, and the arrow positioning logic is fragile.

### Bottom sheet implementation pattern

```css
.bottom-sheet {
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  max-height: 90vh;
  border-radius: 16px 16px 0 0;
  padding-bottom: env(safe-area-inset-bottom);
  transform: translateY(100%);
  transition: transform 0.3s cubic-bezier(0.32, 0.72, 0, 1);
  will-change: transform;
}

.bottom-sheet.open {
  transform: translateY(0);
}

.sheet-scrim {
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,0.4);
  opacity: 0;
  transition: opacity 0.3s;
  pointer-events: none;
}

.sheet-scrim.visible {
  opacity: 1;
  pointer-events: auto;
}
```

For drag-to-dismiss: track `touchstart` Y on the drag handle, update `transform: translateY()` during drag. On release, commit dismiss if dragged > 30% of sheet height or fling velocity > threshold. Disable CSS `transition` during drag (add/remove `.dragging` class), re-enable on release.

### Sheet vs fullscreen:
- Sheet: best for auxiliary actions, file picker, filter/sort, quick settings.
- Fullscreen: best for composing (new note, new chat), complex forms, navigation to a new context.

### Popover anchoring (for tablet-width breakpoints)
- On screens ≥768px, popovers can anchor to their trigger element.
- On phones (<768px), always use bottom sheet regardless of where trigger is.

---

## 9. Specific Recommendations for Loom

### Layout mapping
| Desktop | Mobile |
|---|---|
| Left sidebar (file tree + wiki nav) | Left drawer (edge swipe + tab bar shortcut) |
| Right sidebar (chat, settings) | Bottom sheet or right drawer |
| Top toolbar (actions) | Context toolbar that appears above keyboard when editing |
| Canvas (infinite) | Full screen with pinch/pan, floating zoom controls |
| Tab system (multiple panels) | Bottom tab bar: Canvas / Files / Chat / Settings |

### Tab bar structure (4 tabs)
1. Canvas — the infinite canvas view
2. Files — file browser (push navigation)
3. Chat — AI agent chat
4. Settings — gear icon, far right

### Navigation hierarchy for Files tab
- File list (root) → folder → file (push navigation, swipe-back to go up)

### Chat tab
- Full-screen message list + sticky input bar at bottom
- Handle iOS keyboard with `visualViewport` resize listener
- Long press on message → bottom sheet with actions (copy, edit, delete)

### Canvas tab
- `touch-action: none` on canvas element
- Two-pointer tracking for pinch zoom
- Floating overlay: zoom level indicator, zoom-to-fit button (anchored to bottom-right above tab bar)
- Long press on canvas → context menu as bottom sheet

### Safe area baseline (add to global styles)
```css
:root {
  --tab-bar-height: 60px;
  --safe-bottom: env(safe-area-inset-bottom, 0px);
  --tab-bar-total: calc(var(--tab-bar-height) + var(--safe-bottom));
}
```

---

## Sources

- [Obsidian vs Notion 2026 comparison](https://tech-insider.org/notion-vs-obsidian-2026/)
- [Bottom Navigation Pattern on Mobile Web Pages — Smashing Magazine](https://www.smashingmagazine.com/2019/08/bottom-navigation-pattern-mobile-web-pages/)
- [Bottom Tab Bar Navigation Design Best Practices — UX Planet](https://uxplanet.org/bottom-tab-bar-navigation-design-best-practices-48d46a3b0c36)
- [Hamburger Menus and Hidden Navigation Hurt UX Metrics — NN/G](https://www.nngroup.com/articles/hamburger-menus/)
- [Discord New Mobile App Updates & Layout](https://support.discord.com/hc/en-us/articles/12654190110999-New-Mobile-App-Updates-Layout)
- [Discord tests bottom tab design and swipe gestures — XDA](https://www.xda-developers.com/discord-android-bottom-tab-redesign-swipe-gestures/)
- [Make Your PWAs Look Handsome on iOS — DEV Community](https://dev.to/karmasakshi/make-your-pwas-look-handsome-on-ios-1o08)
- [Safe Areas with CSS Environmental Variables — Frontend Masters](https://frontendmasters.com/courses/pwas-v2/safe-areas-with-css-environmental-variables/)
- [env() CSS function — MDN](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Values/env)
- [Bottom Sheets — NN/G](https://www.nngroup.com/articles/bottom-sheet/)
- [Bottom sheets — Material Design 3](https://m3.material.io/components/bottom-sheets/guidelines)
- [touch-action CSS property — MDN](https://developer.mozilla.org/en-US/docs/Web/CSS/touch-action)
- [Add touch to your site — web.dev](https://web.dev/articles/add-touch-to-your-site)
- [overscroll-behavior — MDN](https://developer.mozilla.org/en-US/docs/Web/CSS/overscroll-behavior)
- [Take control of your scroll — Chrome Developers](https://developer.chrome.com/blog/overscroll-behavior/)
- [How to Handle Trackpad Pinch-to-Zoom vs Two-Finger Scroll — Tiger Abrodi](https://tigerabrodi.blog/how-to-handle-trackpad-pinch-to-zoom-vs-two-finger-scroll-in-javascript-canvas-apps)
- [Using Bottom Tab Bars on Safari iOS 15 — Samuel Kraft](https://samuelkraft.com/blog/safari-15-bottom-tab-bars-web)
- [Obsidian Mobile Swipe Navigation Toolbar — Obsidian Forum](https://forum.obsidian.md/t/swipe-the-mobile-navigation-toolbar-to-switch-between-tabs/102969)
- [The Notch and CSS — CSS-Tricks](https://css-tricks.com/the-notch-and-css/)
