"""Populate the user's vault with wiki entries from session learnings."""

from pathlib import Path
from vault_mcp.lib.frontmatter import write_frontmatter
from vault_mcp.tools.compile import update_master_index, append_log
from vault_mcp.web import bootstrap_vault

vault = Path.home() / "Documents" / "vault"
bootstrap_vault(vault)


def w(rel_path, title, tags, content):
    path = vault / rel_path
    path.parent.mkdir(parents=True, exist_ok=True)
    write_frontmatter(path, {"title": title, "type": "concept", "tags": tags}, content)
    print(f"  Created: {rel_path}")


# 1. Claude Agent SDK
w("wiki/concepts/claude-agent-sdk/README.md", "Claude Agent SDK", ["claude", "sdk"],
"""# Claude Agent SDK

Python/TypeScript SDK for spawning Claude Code as a subprocess.

## Installation
```bash
pip install claude-agent-sdk
```

## Basic Usage
```python
from claude_agent_sdk import query, ClaudeAgentOptions, ResultMessage

async for event in query(
    prompt="Your question",
    options=ClaudeAgentOptions(
        cwd="/path/to/project",
        thinking={"type": "enabled", "budget_tokens": 10000},
        model="sonnet",
        resume=session_id,
    ),
):
    if isinstance(event, ResultMessage):
        print(event.result)
```

## Key Types
- **StreamEvent** - streaming deltas (text_delta, thinking_delta)
- **AssistantMessage** - full message with content blocks
- **ResultMessage** - final result text
- **SystemMessage** - init event with session_id

## Gotchas
- `ThinkingConfigAdaptive()` returns empty dict - use `{"type": "enabled", "budget_tokens": N}` manually
- Each `query()` spawns a NEW subprocess (~2-3s overhead)
- `resume` needs the SDK's session_id (from init event), not your own
- System prompt is APPENDED to Claude Code's built-in prompt

## Performance
- ~2-3s per message (subprocess spawn + API latency)
- Same speed as Claude Code terminal
- Direct Anthropic API would be ~0.5-1s but loses tool capabilities
""")


# 2. Knowledge Base Architecture
w("wiki/concepts/knowledge-base-architecture/README.md", "Knowledge Base Architecture", ["knowledge-base", "llm"],
"""# Knowledge Base Architecture

Pattern for LLM-maintained knowledge bases. Based on Karpathy's approach (April 2026).

## Core Idea
Instead of RAG, the LLM incrementally compiles raw sources into a persistent wiki.
Knowledge is compiled once and kept current.

## Three Layers
1. **Raw sources** - immutable input (articles, papers, repos)
2. **Wiki** - LLM-generated markdown (summaries, concepts, indexes)
3. **Schema** - instructions for the LLM (CLAUDE.md)

## Operations
- **Ingest** - add source, LLM updates wiki (touches 10-15 pages)
- **Query** - search wiki, synthesize answer, optionally file it back
- **Lint** - broken links, stale pages, orphans, missing concepts

## Retrieval (No RAG)
At personal scale (~500 pages):
- Master index (~15K tokens) fits in context
- LLM reads index, finds pages, drills in
- Ripgrep for exact matches
- No vector DB until ~1000+ pages

## Research Findings
- Flat index > hierarchical summaries (cascade maintenance problem)
- Let LLM route itself via index
- Content hashes + git for staleness
- Human-in-the-loop for chat-to-knowledge extraction

## Source
[Karpathy's gist](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)
""")


# 3. Vault Project
w("wiki/concepts/vault-project/README.md", "Vault Project", ["vault", "project"],
"""# Vault Project

Local-first workspace: knowledge wiki + code projects + papers + embedded Claude chat.

## Architecture
- **Folder-as-page model** - every folder is a page (README.md = content)
- **MCP server** - 28 deterministic tools
- **Web UI** - infinite canvas with WebCoLa layout, drill-in, chat panel
- **Tauri app** - native macOS wrapper (7.7MB)

## Key Technical Learnings
- CSS Transform Canvas > Cytoscape.js for embedded documents
- WebCoLa gives non-overlap guarantees for rectangular nodes
- d3-zoom v3 uses pointer events (not mousedown)
- pointer-events:none on parent breaks child cursors in WebKit
- SVG doesn't evaluate CSS var() in innerHTML
- Claude Agent SDK spawns new subprocess per query (~2-3s)

## Scaling Triggers
- >30K token master index: add sqlite-vec
- >200 visible edges: edge bundling
- >1GB vault: git-lfs
- >50 stale READMEs: batch compilation
""")


# 4. Workflow
w("wiki/concepts/claude-project-workflow/README.md", "Claude Project Workflow", ["workflow", "claude"],
"""# Claude Project Workflow

Pattern for starting projects with Claude:

1. **Chat session** - discuss idea, explore design, make decisions
2. **Draft instruction file** - Claude drafts a markdown bootstrap file
3. **New Claude Code session** - paste bootstrap, Claude sets up project
4. **Iterate** - build features, fix bugs, discuss, repeat

## Principles
- Bootstrap file captures all decisions (no re-derivation)
- Plan mode for non-trivial tasks
- Write tests at each step
- Commit frequently
- Vault compounds knowledge across projects
""")


# Update index and log
update_master_index(vault)
append_log(vault, "compile", "Added 4 wiki entries: Claude Agent SDK, KB Architecture, Vault Project, Workflow")
print("\nDone! Wiki entries created in ~/Documents/vault")
