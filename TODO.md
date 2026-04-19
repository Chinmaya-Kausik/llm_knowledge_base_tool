# TODO

Ordered by: validate what's built → UX stability → features.

## Done
- ~~ABOUT.md migration~~ — code reads ABOUT.md, all projects have ABOUT.md files
- ~~Migrate repos to loom~~ — repos moved to ~/Documents/loom/projects/
- ~~Distribute loom repo content~~ — ABOUT.md, memory files, MEMORY.md indexes created
- ~~Adaptive context budget~~ — implemented with configurable caps
- ~~Chat compaction~~ — PreCompact snapshots, serial summarization on Continue
- ~~Chat transcript tagging (backend)~~ — auto-tagging from context_path; canvas tag filter code exists but may need debugging
- ~~TeX compilation~~ — compile .tex to PDF, side-by-side preview, split view
- ~~Tauri app~~ — renamed to Loom, default root ~/Documents/loom
- ~~Image paste in chats~~ — upload, attachment bar, inline display, lightbox
- ~~Multi-panel chat isolation~~ — escape/interrupt scoped to focused panel
- ~~Duplicate thinking fix~~ — ThinkingBlock no longer re-sent after streaming deltas
- ~~Auto cache busting~~ — mtime-based query strings on static assets
- ~~Canvas-aware tag filter~~ — filter shows only tags from current canvas level, updates on navigation
- ~~Sidebar double-click navigation~~ — dblclick opens files in current view, navigates folders
- ~~Demo chat tag backfill~~ — backfilled tags on 35 existing demo chats from context_path
- ~~Fork from last focused panel~~ — Ctrl+Shift+N forks the last interacted-with panel, not just main
- ~~Chat with Claude opens new panel~~ — tooltip now opens a new floating panel with quoted text pre-filled and auto-resized
- ~~Tauri self-contained app~~ — auto-starts Python server, waits for readiness, error pages for missing deps, clean shutdown
- ~~Stale config guard~~ — rejects pytest/tmp paths in ~/.loom-app-config.json, falls back to default
- ~~Test config isolation~~ — settings test no longer pollutes ~/.loom-app-config.json
- ~~VM integration~~ — SSH pool (asyncssh), target dropdown, Canvas/Files/Search on remote, MCP tools (vm_bash/read/write/edit/glob/grep/push/pull/status), SSH terminals, metrics, jobs, ports
- ~~Agent adapter layer~~ — AgentAdapter base class, Claude Code/Codex/Generic CLI adapters, chat.py refactored to agent-agnostic
- ~~Auth middleware~~ — token-based auth for remote access (LOOM_REMOTE=1), localhost exempt, WS auth, CORS
- ~~Visibility toggles~~ — split into dotfiles/build artifacts/loom internals, all work across canvas+files+sidebar
- ~~Canvas position persistence~~ — canvasStack saved to sessionStorage, restored on reload
- ~~Background agents~~ — push running agent to background, continue chatting, pop out when done

## 1. Chat Transcript Tagging UI
- Canvas tag filter working (canvas-aware, updates on navigation)
- Dedicated chat history view: group/filter saved chats by project tag
- Quick access to recent chats per project

## 2. Memory End-to-End
- Verify memory injection works in web chat with real project memories
- Verify Claude creates memories following loom root CLAUDE.md instructions
- Compiler agent updated for memory reporting: `/compile` reports stale memories, verifies MEMORY.md index drift

## 3. In-App Bug Reporting

Quick bug report shortcut that sidesteps everything:
- **Trigger**: keyboard shortcut (e.g. Cmd+Shift+B) or button in settings/panel menu
- **Captures**: recent console logs (ring buffer), last N WebSocket events per panel, backend request log, current panel state (generating, queued messages, subagent status)
- **Output**: saves to `raw/bug-reports/{timestamp}-{annotation}.md` with structured sections
- **Annotation**: prompt for a one-line description of what went wrong
- **Backend endpoint**: `/api/bug-report` that dumps server-side state (active sessions, recent errors, last N chat events per session)

## 4. Subagent Stuck Detection

Subagents in non-main chats can get stuck indefinitely:
- **Timeout**: detect when a subagent has been running too long (configurable, e.g. 5 min)
- **Force-cancel**: backend timeout on `client.interrupt()` / `client.disconnect()` (partially done — 3s timeout added)
- **UI indicator**: show stale/stuck badge on subagent activity blocks
- **Auto-recovery**: if a subagent is stuck and user sends a new message, kill and restart the session

## 5. Smooth Software Updates

Update loom code without losing chat state:
- **Hot reload**: pull new code, restart server, browser detects reconnect and re-renders
- **Chat persistence**: WebSocket reconnect on server restart — restore session from saved transcript
- **Chat continuation**: resume saved chats like normal chats (inject compaction summary + recent messages) instead of full reload
- **No truncation**: saved transcripts preserved across updates; compaction metadata enables efficient continuation
- Launcher scripts (`loom-ui.command`, `loom-dev.command`) handle branch checkout + restart

## 6. Git Graph & Diff Visualization

Multiple tabs/windows like VS Code — need git tracking with visual diffs:
- **Git graph**: visual commit/branch graph (D3-based, reuse existing graph infra)
- **Diff viewer**: side-by-side or unified diff view for commits, staged changes, working tree
- **Multiple windows**: ability to have multiple loom windows open, each with multiple tabs
- Panel-based: git graph and diffs as dockable panels (like chat/terminal panels)

## 7. Wiki Review Agent
- Semantic verification of compiled wiki pages (beyond what `/lint` does mechanically)
- Source accuracy: does the page faithfully represent the raw source?
- Contradictions: does the new page contradict existing pages?
- Cross-reference completeness: are obvious connections missing?
- Glossary alignment: does the page use canonical terms?

## 8. Code Review Agent
- Multi-agent review of code changes in loom projects
- Modeled after Claude Code's code review: multiple agents examine changes in parallel, verification step filters false positives
- Post findings with severity levels

## 9. `/memory` Interactive Cleanup
- Plan-mode style review for cross-project and global memories
- Claude scans, proposes changes, user approves each
- Single-project memories managed autonomously by Claude

## In Progress
- PWA manifest + service worker for mobile (phone) access
- Responsive CSS for mobile layout (iterating in Claude Design)
- Ntfy notifications (job done, agent done, sync complete)
- Laptop↔VM sync daemon (auto rsync on change, pull on wake)
- Endpoint switcher (phone tries local → Tailscale → VM → "turn on your laptop")

## Known Issues
- System prompt not updated when adapter is reused mid-session (chat.py _get_or_create_adapter). Context changes don't take effect until next session.
- Premature dequeue: queued message went bright before the current response finished (before `done` event). Needs event log capture (#3) to diagnose.
- ~~Code block overflow~~ — fixed with `overflow: auto; max-height: 300px` on chat pre elements.
- CLAUDE.md coexists with ABOUT.md in loom repo — intentional while VS Code is primary editor. Remove CLAUDE.md once loom is the main workspace.
