# Plan: Wiki as Context Substrate

## Context

Loom's web chat spawns a Claude Code subprocess via the Agent SDK. Currently:
- `system_prompt` is a raw string (~1,500 chars) that **replaces** the Claude Code default prompt
- `setting_sources` is `None` — CLAUDE.md is NOT loaded, even if it existed
- Page content (8K cap) + parent folder README are injected dynamically — this works well
- No memory system — every session starts cold
- Conventions are hardcoded in Python — invisible, uneditable

## Architecture: Modular Context Pipeline

System prompt assembled from independent **context blocks**:

```python
def _some_block(loom_root, page_path, config) -> str | None
```

`build_system_prompt()` composes them. Each block is independently testable, configurable via loom-local `config.yaml`, and removable (return `None` to skip).

## Changes

### 1. Preset + append + setting_sources

**File:** `loom_mcp/chat.py` — `_get_or_create_client()`

```python
system_prompt={"type": "preset", "preset": "claude_code", "append": system_prompt},
setting_sources=["project"],
```

Verified working: both CLAUDE.md and appended text loaded by subprocess.

### 2. Bootstrap additions

**Files:** `loom_mcp/web.py`, `loom_mcp/server.py`

Bootstrap creates (if not exists):
- `CLAUDE.md` at loom root — structure, conventions pointers, memory instructions
- `wiki/meta/conventions.md` — detailed conventions (editable from canvas)
- `wiki/meta/memory/` directory
- `.claude/settings.json` — copy hooks (mdformat) to loom's `.claude/`
- Loom-local `config.yaml` with context section

### 3. Refactor `build_system_prompt()` into blocks

**File:** `loom_mcp/chat.py`

- `_permissions_block()` — hardcoded safety permissions + responsiveness
- `_memory_block(loom_root, page_path, config)` — reads project or root MEMORY.md, capped
- `_location_block(loom_root, page_path, context_level, config)` — page content + folder README (kept, works well)
- `_load_context_config(loom_root)` — reads loom-local config.yaml
- Fallback: if no CLAUDE.md at loom root, inject legacy conventions

### 4. Memory system

**Storage:** `wiki/meta/memory/` — individual timestamped files, tagged by project.

```yaml
# wiki/meta/memory/2026-04-07-uses-typescript.md
---
title: Uses TypeScript
type: memory
tags: [my-app]
created: 2026-04-07
---
Project uses TypeScript with strict mode.
```

**Indexes:** Per-project `MEMORY.md` in project folders + global `MEMORY.md` at loom root. One-liners only — this is what gets injected.

**Injection:** `_memory_block()` extracts project name from `page_path` (relative path, first dir under `projects/`), reads that project's `MEMORY.md`. Falls back to root `MEMORY.md` when not in a project. Capped at `config.context.memory.max_chars`.

**Management:**
- Single-project memories: Claude manages autonomously (same as Claude Code)
- Cross-project/global: interactive `/memory` command (plan-mode style, deferred)
- `/compile`: read-only on memories — reports staleness, verifies index drift, never modifies

### 5. Skip MEMORY.md in page walks

**File:** `loom_mcp/lib/pages.py` — `walk_pages()`

Add `MEMORY.md` to the skip list alongside `README.md` (line 140). One-line fix. Memory files in `wiki/meta/memory/` are already excluded (line 146 skips `wiki/meta/` files).

### 6. Loom-local config.yaml

```yaml
context:
  memory:
    enabled: true
    max_chars: 2000
  page_content:
    enabled: true
    max_chars: 8000
  folder_readme:
    enabled: true
```

Read by `_load_context_config(loom_root)`. Existing repo config.yaml is not read by runtime code — no conflicts.

## Known issues (pre-existing, deferred)

- System prompt not updated when client is reused mid-session (lines 351-355 in chat.py). Context changes (navigation, scope) don't take effect until next session. Pre-existing bug.

## Implementation Order

1. Bootstrap additions (CLAUDE.md, conventions.md, memory dir, settings.json, config.yaml)
2. Skip MEMORY.md in walk_pages
3. Refactor build_system_prompt into blocks
4. Switch to preset + append + setting_sources
5. Implement _memory_block
6. Tests

## Critical Files
- `loom_mcp/chat.py` — build_system_prompt (lines 156-240), _get_or_create_client (lines 344-384)
- `loom_mcp/web.py` — bootstrap_loom (lines 40-79)
- `loom_mcp/server.py` — _bootstrap_loom (lines 29-40)
- `loom_mcp/lib/pages.py` — walk_pages (line 140)
- `loom_mcp/tests/test_chat.py`, `loom_mcp/tests/test_web.py`

## Why the plan looks like this

**Why preset + append instead of raw string:** The current code passes a raw string as `system_prompt`, which replaces Claude Code's entire default prompt — losing built-in tool guidance, safety instructions, and other defaults. Using `{"type": "preset", "preset": "claude_code", "append": ...}` preserves Claude Code's full system prompt and adds loom-specific context on top. This is the single highest-impact change: one line that gives the subprocess the complete Claude Code experience it was missing.

**Why CLAUDE.md at the loom root:** The Agent SDK subprocess had zero project context because bootstrap never created a CLAUDE.md and `setting_sources` was unset. This is just using Claude Code's native mechanism correctly — not reinventing anything.

**Why conventions as a wiki page:** CLAUDE.md should be minimal (boot prompt). Detailed conventions (compilation rules, frontmatter schema, style) belong in `wiki/meta/conventions.md` — editable from the canvas UI, visible in the wiki graph, maintained alongside the content it governs. Claude reads it on demand when the task warrants.

**Why centralized memory with per-project indexes:** Memories live in `wiki/meta/memory/` (one place, visible on canvas, covered by existing `wiki/meta/` exclusion in page walks). Each project folder has a `MEMORY.md` index with one-liners — this is what gets injected, matching Claude Code's 200-line/25KB pattern. Cross-project memories get tagged with multiple projects and appear in multiple indexes.

**Why timestamps in filenames:** All memory files share `wiki/meta/memory/`. Without timestamps, two projects could create `uses-typescript.md`. Timestamps (`2026-04-07-uses-typescript.md`) prevent collisions cheaply.

**Why compile is read-only on memories:** Two unrelated or opposing memories could get incorrectly merged by automated consolidation. The compiler lacks context about why seemingly contradictory memories both exist (different projects, different phases). It reports and flags; the user decides. Single-project memories can be managed autonomously by Claude within that project (same as Claude Code). Cross-project cleanup is interactive via `/memory` (plan-mode style).

**Why modular blocks:** The user needs to tune prompt weight vs inference speed. Each context source (permissions, memory, page content, folder README) is an independent function controlled by `config.yaml`. Change `max_chars`, switch `enabled` to `false`, no code changes. Add a new context source by writing one function.

**Why keep page content + folder README injection:** Confirmed working well in practice. Folder READMEs provide qualitative context (purpose, relationships, key variants) cheaply. Page content means Claude can immediately help with what the user is viewing. Removing them would save ~2K tokens but add latency to the most common interaction.

## How this differs from Claude Code

| Aspect | Claude Code | Loom | Why different |
|---|---|---|---|
| System prompt | Built-in default | Preset + append | We were accidentally replacing the default with a raw string. |
| Memory storage | `~/.claude/projects/*/memory/` | `wiki/meta/memory/` with project tags | Wiki gives canvas visibility, search, compilation, links. |
| Memory index | MEMORY.md per project, 200 lines | MEMORY.md per project folder + root global | Same pattern. Cross-project via tags in multiple indexes. |
| Memory scope | Per-project, isolated | Cross-project via tags | A memory tagged `[my-app, research]` appears in both indexes. |
| Memory cleanup | None (manual only) | Single-project: autonomous. Cross-project: interactive `/memory`. `/compile`: report-only. | Safer than Claude Code's "no cleanup." Compile catches index drift. |
| Conventions | In CLAUDE.md | In `wiki/meta/conventions.md` | Editable from canvas, not buried in a dotfile. |
| Dynamic context | None (reads on demand) | Page content + folder README injected | Loom has spatial state — inject what the user is viewing. |
| Configurability | Not configurable | `config.yaml` per block | Tune for speed vs richness without code changes. |
| File naming | Slug-based | Timestamped | Avoids collisions in shared `wiki/meta/memory/` directory. |

**What we gain:** cross-project memory, visible/editable context, configurable prompts, spatial context, compile-time memory health checks.

**What we preserve:** native CLAUDE.md loading, full Claude Code default prompt, MEMORY.md index pattern, per-project memory autonomy.

## Relationship to Karpathy's LLM Wiki pattern

Karpathy's gist describes a three-layer architecture (raw sources → wiki → schema) with ingest/query/lint operations and navigation files (index.md, log.md). Loom already implements all of this. This plan extends the pattern with an operational context layer Karpathy doesn't discuss:

| Karpathy pattern | Loom has | This plan adds |
|---|---|---|
| Raw → Wiki → Schema | ✓ | CLAUDE.md at loom root (was missing) |
| Ingest/Query/Lint | ✓ | — |
| index.md / log.md | ✓ | — |
| "File answers back" | ✓ (`/file-answer`) | — |
| Schema configuration | Partial (hardcoded in Python) | CLAUDE.md + conventions.md as wiki page |
| Cross-session memory | ✗ | wiki/meta/memory/ + per-project MEMORY.md indexes |
| Cross-project knowledge | Implicit (one wiki) | Explicit via tagged memories + wiki cross-links |

The key extension: Karpathy's wiki handles knowledge (what things mean). Our memory system handles operational context (how to work here, what was decided). The wiki cross-pollinates knowledge during `/compile`. Memory stays local to projects. They're complementary layers.

## Implementation Order (detailed)

1. **Bootstrap additions** — CLAUDE.md, conventions.md, memory dir, settings.json, config.yaml
   - Apply to demo loom (`~/Documents/loom-demo/`)
   - Latency baseline: measure response time with current system
2. **Skip MEMORY.md in walk_pages** — one-line fix in pages.py
3. **Refactor build_system_prompt into blocks** — split into _permissions_block, _memory_block, _location_block
   - Latency test: measure after refactor (should be neutral — same content, different structure)
4. **Switch to preset + append + setting_sources** — one-line change in _get_or_create_client
   - Latency test: measure impact of full Claude Code default prompt being added
   - This is the change most likely to affect latency (larger system prompt)
5. **Implement _memory_block** — read project/root MEMORY.md, inject capped
   - Apply to demo loom: create sample memories, project MEMORY.md
   - Latency test: measure with memory injection active
6. **Tests** throughout
7. **Apply to real loom** (`~/Documents/loom/`) once demo is validated

Each step: run `uv run pytest`, apply to demo loom, measure latency.

## Verification
1. `uv run pytest` — all tests pass
2. Latency tests against demo loom at each step (baseline → bootstrap → refactor → preset → memory)
3. Manual: start web UI, chat, verify Claude has project awareness
4. Manual: ask Claude to remember something, verify memory file + MEMORY.md
5. Manual: change config.yaml, verify behavior changes
