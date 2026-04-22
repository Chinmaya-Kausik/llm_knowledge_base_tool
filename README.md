# Loom

A workspace and knowledge base on an infinite canvas. Files as cards, Claude Code as the built-in agent, markdown on disk, git-versioned.

<!-- ![Loom screenshot](screenshot.png) -->

## Why

I had papers, code, notes, and half-finished ideas scattered across folders, and the tools I was using didn't share state with each other. Claude Code is good for working with files, but it's a terminal -- you can't see spatial relationships between things. File managers, editors, and AI chat are separate applications.

I wanted one place where files live on a canvas as cards I can arrange and connect, with Claude Code running inside the same UI -- multiple chat panels, inline diffs, terminals, and programmatic permissions. There's also a knowledge base pipeline: ingest sources, compile them into wiki pages, and the accumulated context carries across conversations.

It started as a knowledge base tool and grew into more of a workspace: navigating files, editing code, running agents, compiling papers, and building up structured knowledge.

A demo loom is included in `demo/`. Its `CLAUDE.md`, `config.yaml`, and `wiki/meta/conventions.md` serve as templates -- bootstrap creates these in any new loom.

## Quick Start

```bash
git clone https://github.com/Chinmaya-Kausik/loom.git
cd loom

uv sync --extra web --extra dev

export LOOM_ROOT=~/my-loom   # or omit to use current dir

uv run --extra web python -m loom_mcp.web
# Open http://localhost:8420
```

Or double-click `loom-ui.command` to launch with auto browser open.

### Native App (macOS)

```bash
cargo install tauri-cli
cargo tauri build
ln -sf "$(pwd)/src-tauri/target/release/bundle/macos/Loom.app" /Applications/Loom.app
```

Produces a Tauri v2 binary that starts the Python server as a sidecar.

## How Loom extends Claude Code

Loom wraps Claude Code (and other coding agents) in a visual workspace:

- **Agent-agnostic.** Switch between Claude Code, OpenAI Codex, or any CLI agent per-panel. Agent adapter layer translates each agent's protocol into a common event stream.
- **VM integration.** Connect to remote VMs via SSH. Target dropdown switches Canvas/Files/Search between local and remote. Full MCP tool suite mirrors built-in tools for VMs (`vm_bash`, `vm_read`, `vm_write`, `vm_edit`, `vm_glob`, `vm_grep`). SSH terminals, live metrics, job management, port forwarding.
- **Background agents.** Push a running agent to the background and keep chatting. Pop it out into a new panel when it's done.
- **Selective tool call expansion.** Expand individual tool calls while the agent keeps working. Edit calls show inline diffs. Details preserved in saved transcripts.
- **Browsable chat transcripts.** Auto-saves to `raw/chats/` as markdown. Browse in the file explorer, open, and continue where you left off.
- **Fork any conversation.** Branch a chat with full context without losing the original thread.
- **Redirect with checkpoints.** Set breakpoints on tool calls, intervene with corrective feedback.
- **Multiple concurrent agents.** Floating, docked, or minimized panels. Each with its own session and agent.
- **Spatial file navigation.** Files as cards on an infinite canvas with wiki-link edges. Drill into folders, arrange spatially.
- **Browser-configurable permissions.** Per-category rules (allow/ask/deny) enforced via `can_use_tool` callback.
- **Terminals.** Local and SSH terminal panels alongside chat and canvas.
- **Knowledge base pipeline.** Ingest URLs and PDFs, compile into wiki pages with cross-links and a master index.
- **Selection-to-Claude.** Highlight text anywhere for an "Ask Claude" tooltip with context injection.
- **Remote access.** Token-based auth for accessing Loom from other devices. CORS support.
- **Mobile (PWA).** Installable on iPhone/Android. Endpoint switcher tries local WiFi -> Tailscale -> VM fallback -> "turn on your laptop."
- **Ntfy notifications.** Push notifications when agents finish, jobs complete, or sync happens.
- **Sync daemon.** Auto-syncs memory/wiki/transcripts between laptop and VM via rsync. Pulls from VM on wake from sleep.

## Features

### Canvas and Views
- Infinite pan/zoom canvas with document cards (d3-zoom, d3-force layout with rectangular collision)
- Files view with tree/tile toggle, Mac-style folder icons, breadcrumb navigation
- Provenance graph view linking raw sources to wiki pages
- Cards show rendered markdown, syntax-highlighted code, or PDF content
- Drill into folders, expand/collapse/resize/reposition cards, multi-select with Cmd+click
- Edges show `[[wiki-link]]` connections, aggregated at top level
- Filetype filtering (Markdown, Code, Papers, Data, Misc)

### Chat
- Multiple concurrent chat panels — floating, dockable, forkable
- Agent-agnostic: Claude Code, OpenAI Codex, or any CLI agent per panel
- Background agents: push running agents to background, pop out when done
- Context levels: Page, Folder, or Global (master index)
- Streaming responses with collapsible thinking trace and tool use blocks
- Inline diffs for Edit calls, command display for Bash, expandable tool details
- Activity summaries that count unique files ("Edited 1 file, Read 3 files")
- Subagent display with nested tool calls
- Redirect/checkpoint, message queue, interrupt prompt, fork with full context
- Text selection anywhere shows "Ask Claude" with context injection
- Auto-saves transcripts to `raw/chats/` on close
- KaTeX rendering in chat and fullpage views

### Settings
- Two-pane full settings panel (Cmd+,) with 12 sections: Account, Workspace, Storage, Appearance, Model, Permissions, Memory, Indexing, Keyboard, Integrations, Privacy, About
- Font pickers: UI font, reading font, code font (Inter, JetBrains Mono, Newsreader, system fonts)
- Font size slider scales entire type scale
- Density control (compact/standard/roomy) — spacing only, not font sizes
- Three themes (dark/light/paper) with slate palette variant
- Context popover with real system prompt tracing (shows exactly what files are injected)
- Workspace file browser for selecting loom root
- Custom agent configuration (add any CLI agent)
- All fonts bundled locally — zero external network calls

### Permissions
- Programmatic enforcement via the Agent SDK's `can_use_tool` callback — not just system prompt instructions
- Per-category rules (file read, file write, shell, MCP tools, destructive operations) configurable from the browser
- Three modes: Allow, Ask (interactive prompt with Enter to confirm), Deny
- Destructive command detection (`rm`, `sudo`, `chmod`, `git push --force`, `git reset --hard`) with expanded blocklist
- Fail-closed on permission check errors (denies by default)
- Concurrent permission requests supported (keyed by tool_use_id)

### Editing and Terminal
- CodeMirror 6 editor with syntax highlighting (Cmd+E to edit, Cmd+S to save)
- Embedded terminal panels via xterm.js (Cmd+` to open)
- Plan mode — interactive checklist panel for agent plans

### Search
- Content, name, and global search with match highlighting inside files
- Powered by ripgrep (vendored binary auto-detected)

### Knowledge Base Workflows
- `/ingest <url>` — capture a URL or PDF into `raw/`
- `/compile` — incrementally compile changed sources into structured wiki pages
- `/query <question>` — search the wiki and synthesize an answer
- `/lint` — run health checks with scaling trigger monitoring
- `/file-answer` — write the last answer back to the wiki

The compilation pipeline produces wiki pages with YAML frontmatter, `[[wiki-link]]` cross-references, and a master index.

### MCP Server (39 tools)
- **Ingestion**: `ingest_url`, `ingest_pdf`, `ingest_text`, `classify_inbox_item`
- **Reading**: `read_source`, `read_wiki_page`, `get_page_registry`, `get_glossary`
- **Compilation**: `write_wiki_page`, `mark_source_compiled`, `update_glossary`, `update_master_index`, `append_log`
- **Indexes**: `read_index`, `write_index`
- **Linting**: `validate_links`, `find_stale_pages`, `find_orphan_pages`, `find_missing_concepts`, `check_terminology`, `generate_health_report`
- **Search**: `ripgrep_search` with file glob and scope filtering
- **Maintenance**: `get_changed_sources`, `detect_changes`, `get_stale_readmes`, `save_chat_transcript`
- **Git**: `auto_commit`, `get_recent_changes`
- **VM**: `vm_bash`, `vm_read`, `vm_write`, `vm_edit`, `vm_glob`, `vm_grep`, `vm_push`, `vm_pull`, `vm_status`

## Keyboard Shortcuts

All shortcuts are rebindable via Cmd+K.

| Shortcut | Action |
|----------|--------|
| Cmd+1/2/3/4 | Switch views |
| Cmd+J | Cycle chat focus |
| Cmd+N | New chat |
| Cmd+Shift+N | Fork chat with context |
| Cmd+T | Toggle tree/tile |
| Cmd+B | Toggle sidebar |
| Cmd+E | Edit current file |
| Cmd+S | Save |
| Cmd+` | New terminal |
| Cmd+K | Show/edit shortcuts |
| Cmd+F | Focus search |
| Cmd+=/- | Zoom in/out |
| Cmd+0 | Fit view |
| Cmd+L | Auto layout |
| Cmd+[/] | Navigate back / drill in |
| Cmd+Shift+H | Restart server (clears caches, full reload) |
| Cmd+, | Open settings |
| Escape | Collapse or navigate back |

## Security

See [SECURITY.md](SECURITY.md) for vulnerability reporting and the full security architecture.

- Path traversal protection on all file-serving endpoints
- Auth token + cookie-based remote access with per-origin CORS
- SSH host key verification enabled by default
- Shell escaping on all VM command tools
- Session TTL cleanup (1 hour inactive)
- No telemetry, no external network calls (fonts bundled locally)

## Architecture

```
loom/                       <- A loom directory (user content)
  CLAUDE.md                 <- Project context for Claude (auto-created)
  MEMORY.md                 <- Global memory index (user-created)
  config.yaml               <- Loom-local config (context tuning)
  wiki/                     <- LLM-maintained structured knowledge
    meta/
      memory/               <- Cross-project memory files
      conventions.md        <- Editable project conventions
      index.md              <- Master page catalog
      glossary.md           <- Canonical terms
  raw/                      <- Ingested sources + saved chat transcripts
  projects/                 <- Active code repos, experiments
    my-project/
      MEMORY.md             <- Project-specific memory index
  outputs/                  <- Generated artifacts

loom_mcp/                   <- This repo (the tool)
  agents/                   <- Agent adapter layer (Claude Code, Codex, Generic CLI)
  vm/                       <- VM integration (SSH pool, sync, metrics, jobs)
  server.py                 <- 39 MCP tools (stdio transport)
  web.py                    <- FastAPI server + WebSocket endpoints + auth
  chat.py                   <- Agent-agnostic chat bridge
  lib/                      <- Core: pages, frontmatter, links, hashing
  tools/                    <- Ingest, compile, search, lint, git
  static/
    index.html              <- Single-page app shell
    style.css               <- Dark theme styles
    app.js                  <- Frontend (~7000 lines, vanilla JS)
    vendor/                 <- d3, WebCoLa, marked, pdf.js, CodeMirror 6, xterm.js, KaTeX

demo/                       <- Demo loom (included in repo)
src-tauri/                  <- Tauri v2 native app (optional)
```

**Key design decisions:**
- **Agent-agnostic.** Adapter layer translates Claude Code, Codex, or any CLI agent into a common event stream.
- Every folder is a page (ABOUT.md = content). Files are subpages. README.md is a GitHub artifact, not special to loom.
- LLM reasoning happens in the agent. Python tooling is strictly deterministic — no API calls from the backend.
- No API key needed in the server. Claude Code uses your Max subscription.
- No build step. ~7000 lines of vanilla JS with vendored libraries.
- Permission system enforced programmatically via `can_use_tool`, not just system prompt instructions.
- System prompt assembled from modular context blocks (permissions, memory, page/folder/VM context), configurable via `config.yaml`.
- Memory files live centrally in `wiki/meta/memory/`, tagged by project. Each project has a MEMORY.md index injected at session start.
- VM integration uses persistent SSH connections (asyncssh) with multiplexed channels. MCP tools mirror all built-in tools for remote execution.

## Tech Stack

- **Backend**: Python 3.12+, FastAPI, Claude Agent SDK, asyncssh, MCP Python SDK
- **Frontend**: Vanilla JS (~7000 lines), CodeMirror 6, xterm.js, d3-zoom, WebCoLa, marked.js, pdf.js, KaTeX
- **Native**: Tauri v2 (Rust)
- **Tools**: uv (package management), ripgrep (search), trafilatura (web extraction), PyMuPDF4LLM (PDF)
- **Tests**: pytest (330+ tests across 26 files)

## Mobile Access

Loom is a PWA -- installable on your phone's home screen:

1. **Enable remote access:** `LOOM_REMOTE=1 uv run --extra web python -m loom_mcp.web`
2. **Set up Tailscale** on laptop and phone (for access outside your home network)
3. **Open** `http://<laptop-ip>:8420` on your phone, tap "Add to Home Screen"
4. **Configure backends** in Settings: add local WiFi IP, Tailscale IP, and optionally a VM fallback

The phone tries backends in order: local WiFi (~3ms) -> Tailscale (~30ms) -> VM fallback (~120ms). If nothing responds, shows "Turn on your laptop."

### Notifications (ntfy)

Install the [ntfy app](https://ntfy.sh) on your phone, then configure in Loom Settings:
- Set a topic name (e.g., `loom-yourname`)
- Subscribe to the same topic in the ntfy app
- Get notifications when: agents finish, VM jobs complete, sync happens

### Sync Daemon

Auto-syncs memory, wiki, and chat transcripts between laptop and VM:
- Polls every 60s for local changes, rsyncs to VM
- Detects wake from sleep, pulls from VM first
- Git safety commits before each sync
- Configure by setting `"sync_vm": "<vm-id>"` in `~/.loom-app-config.json`

Also available standalone: `loom-sync`

## Configuration

- `LOOM_ROOT` env var, `~/.loom-app-config.json`, or the Settings dropdown in the UI
- `LOOM_REMOTE=1` enables remote access with token-based auth
- `.claude/mcp.json` registers the loom MCP server for Claude Code (auto-created on startup)
- `.claude/settings.json` hooks (e.g., mdformat after wiki page writes) — auto-copied on startup
- `CLAUDE.md` at loom root — project context loaded by the Agent SDK subprocess
- `config.yaml` at loom root — context pipeline tuning (memory caps, page content limits, enable/disable blocks)
- `wiki/meta/conventions.md` — detailed project conventions, editable from the canvas
- `~/.loom-app-config.json` — auth token, ntfy config, sync VM, backend list

## Development

See [DEVELOPER.md](DEVELOPER.md) for the full architecture, data model, API endpoints, chat backend internals, and how to add new features.

```bash
uv run pytest                    # All tests
uv run pytest -k "test_chat"     # Subset
```

## License

[Business Source License 1.1](LICENSE) — free for non-commercial use. Converts to Apache 2.0 on 2030-04-06.
