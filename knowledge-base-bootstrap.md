# Claude Code Bootstrap Prompt: Personal Knowledge Base

Copy everything below the line into a new Claude Code session.

---

## Project: Local-First Personal Knowledge Base ("Vault")

I want to build a local-first personal knowledge management system. No Obsidian, no Notion, no third-party services. Just markdown files on my filesystem and Claude Code as the primary interaction layer.

**Critical architectural decision**: All LLM reasoning routes through Claude Code (billed to my Max subscription). The Python tooling is exposed as a **local MCP server** that provides deterministic, non-LLM tools (filesystem I/O, hashing, frontmatter parsing, link validation, search). Claude Code calls these tools, does the thinking, and writes wiki pages. This means zero direct Anthropic API calls from Python — no API key needed, no separate billing.

### Philosophy

- **Local-first**: All data lives as plain markdown and images on my machine. No cloud sync, no proprietary formats, no vendor lock-in.
- **Compilation over retrieval**: Inspired by Karpathy's April 2026 approach. Raw sources go in, an LLM incrementally compiles them into a structured, interlinked wiki. At personal scale (~400K words), modern context windows can ingest entire topic clusters directly — no embeddings, no vector databases, no RAG pipelines. Keep it simple.
- **Max subscription, not API billing**: All LLM reasoning happens inside Claude Code, which bills to my Max subscription. Python code is strictly for deterministic operations (file I/O, hashing, parsing, validation) exposed as MCP tools. No Anthropic SDK calls from Python.
- **The filing loop**: When querying the wiki produces a useful synthesized answer, that answer gets written back as a new wiki entry. The knowledge base compounds from use, not just from ingestion.
- **Conversational interface**: My primary interaction mode is conversation with Claude via Claude Code, not clicking through a UI. The wiki is a directory of markdown files that Claude reads and writes.
- **Lint early, lint often**: LLMs hallucinate links, drift in terminology, and produce stale summaries. Health checks are a first-class operation from day one, not an afterthought.
- **Privacy by default**: Sensitive content never leaves my machine unless I explicitly choose to share it.

### Directory Structure

```
~/vault/
├── CLAUDE.md                  # Project instructions for Claude Code
├── raw/                       # Unprocessed source material
│   ├── articles/              # Web articles (markdown via trafilatura)
│   ├── papers/                # PDFs and paper notes
│   ├── repos/                 # Cloned repos or code snippets
│   ├── media/                 # Images, diagrams, screenshots
│   └── inbox/                 # Quick capture dump — unsorted
├── wiki/                      # LLM-compiled structured knowledge
│   ├── concepts/              # Atomic concept articles (one per topic)
│   ├── summaries/             # Source summaries with backlinks to raw/
│   ├── indexes/               # Auto-generated topic indexes
│   ├── answers/               # Filed-back query results (the filing loop)
│   └── meta/                  # Wiki health, glossary, stats, changelog
│       ├── glossary.md        # Canonical terms — LLM references this during compilation
│       ├── health.md          # Latest lint report
│       └── page-registry.json # List of all wiki pages (for link validation)
├── outputs/                   # Generated artifacts
│   ├── slides/                # Marp-format slide decks
│   ├── reports/               # Long-form synthesized documents
│   └── visualizations/        # matplotlib/mermaid/svg outputs
├── vault_mcp/                 # Local MCP server (deterministic tools, no LLM calls)
│   ├── __init__.py
│   ├── server.py              # MCP server entrypoint (stdio transport)
│   ├── tools/
│   │   ├── ingest.py          # URL/PDF/text ingestion tools
│   │   ├── compile.py         # Hash checking, frontmatter management, registry updates
│   │   ├── search.py          # Ripgrep wrapper + index file reader
│   │   ├── lint.py            # Link validation, staleness detection, orphan finder
│   │   └── git.py             # Auto-commit helpers
│   ├── lib/
│   │   ├── frontmatter.py     # Frontmatter read/write/validate
│   │   ├── hashing.py         # SHA-256 content hashing
│   │   ├── links.py           # [[wiki-link]] parsing and resolution
│   │   └── registry.py        # page-registry.json management
│   └── tests/
│       ├── test_ingest.py
│       ├── test_compile.py
│       ├── test_lint.py
│       └── test_links.py
├── .claude/
│   ├── agents/                # Custom subagent definitions (YAML frontmatter + instructions)
│   │   ├── compiler.md        # Wiki compilation agent
│   │   ├── linter.md          # Health check agent
│   │   └── researcher.md      # Web research + ingestion agent
│   └── commands/              # Slash commands for common operations
│       ├── compile.md         # /compile — run incremental compilation
│       ├── ingest.md          # /ingest <url> — capture a URL
│       ├── query.md           # /query <question> — search + synthesize
│       ├── lint.md            # /lint — run health checks
│       └── file-answer.md     # /file-answer — write last answer back to wiki
├── .gitignore
└── config.yaml                # Vault configuration
```

### Frontmatter Schema

Every wiki page MUST have this frontmatter. This is what makes incremental compilation, linting, and staleness detection work.

```yaml
---
title: "Transformer Architecture"
type: concept                    # concept | summary | index | answer | structure-note
status: compiled                 # compiled | draft | stale | needs-review
created: 2026-04-03
last_compiled: 2026-04-03T14:25:00Z
source_hash: "a1b2c3d4..."      # SHA-256 of source content at compilation time
compiler_model: "claude-sonnet-4-20250514"
compiler_prompt_version: "v1.0"  # Bump when compilation prompts change
sources:                         # Provenance — what raw files produced this page
  - path: "raw/papers/attention-paper.pdf"
    hash: "e5f6g7h8..."
tags: [machine-learning, attention-mechanism]
related: ["[[Self-Attention]]", "[[BERT]]", "[[Sequence-to-Sequence]]"]
aliases: ["Transformer", "Transformer model", "Vaswani architecture"]
confidence: high                 # high | medium | low — LLM's self-assessed confidence
---
```

Raw source files in `raw/` get simpler frontmatter:

```yaml
---
title: "Attention Is All You Need"
source_url: "https://arxiv.org/abs/1706.03762"
captured: 2026-04-03T10:00:00Z
content_type: paper              # article | paper | repo | snippet | note
content_hash: "abc123..."       # SHA-256 of content body (excluding frontmatter)
tags: [machine-learning, transformers]
compiled: true                   # Has this been processed by compile.py?
---
```

### Core Features to Build (in priority order)

**Phase 1: Foundation — Build the MCP server and get the core loop working**

The MCP server exposes deterministic tools. Claude Code does all the reasoning and writing.

1. **MCP server setup** (`vault_mcp/server.py`):
   - Use the **MCP Python SDK** (`mcp`) with **stdio transport** (Claude Code connects to it as a local MCP server).
   - Register in `.claude/mcp.json` so Claude Code auto-connects:
     ```json
     {
       "mcpServers": {
         "vault": {
           "command": "uv",
           "args": ["run", "--directory", "/path/to/vault/vault_mcp", "python", "-m", "vault_mcp.server"]
         }
       }
     }
     ```
   - Each tool is a function that takes structured input and returns structured output. No LLM calls inside any tool.

2. **Ingestion tools** (`vault_mcp/tools/ingest.py`):
   - `ingest_url(url: str) → {path, title, content_hash}`: Fetch URL via **trafilatura** with `output_format="markdown"`, write to `raw/inbox/` with auto-generated frontmatter, compute content hash. Returns the file path so Claude Code can review/classify.
   - `ingest_pdf(filepath: str) → {path, title, content_hash}`: Extract PDF to markdown via **PyMuPDF4LLM**, write to `raw/inbox/` with frontmatter. Fall back to **marker-pdf** for complex papers (expose as `ingest_pdf_complex`).
   - `ingest_text(text: str, title: str) → {path, content_hash}`: Write raw text to `raw/inbox/` with frontmatter.
   - `classify_inbox_item(source: str, destination: str)`: Move a file from `raw/inbox/` to the appropriate `raw/` subdirectory.

3. **Compilation support tools** (`vault_mcp/tools/compile.py`):
   These tools assist Claude Code during compilation. Claude Code does the actual synthesis/writing.
   - `get_changed_sources() → [{path, content_hash, old_hash, status}]`: Scan `raw/` for files where `compiled: false` or where content hash has changed. Returns the list of sources needing compilation.
   - `get_page_registry() → {pages: [{title, path, aliases}]}`: Read `wiki/meta/page-registry.json`.
   - `get_glossary() → str`: Read `wiki/meta/glossary.md` content.
   - `read_source(path: str) → {frontmatter, content}`: Read a raw source file, parse frontmatter.
   - `read_wiki_page(path: str) → {frontmatter, content}`: Read a wiki page, parse frontmatter.
   - `write_wiki_page(path: str, frontmatter: dict, content: str)`: Write a wiki page with validated frontmatter. Auto-updates `page-registry.json` if it's a new page.
   - `mark_source_compiled(path: str, hash: str)`: Update `compiled: true` and `content_hash` in a raw source's frontmatter.
   - `update_glossary(term: str, definition: str)`: Append a term to `wiki/meta/glossary.md`.

4. **Linting tools** (`vault_mcp/tools/lint.py`) — **Phase 1, not Phase 2**:
   - `validate_links() → [{page, link, status}]`: Parse all `[[wiki-links]]` across `wiki/`, check each against `page-registry.json` and filesystem. Return broken links.
   - `find_stale_pages() → [{page, source, expected_hash, actual_hash}]`: Compare `source_hash` in wiki frontmatter against current raw source hashes.
   - `find_orphan_pages() → [path]`: Wiki pages with zero inbound backlinks.
   - `find_missing_concepts() → [term]`: Terms in `related` fields that have no corresponding concept article.
   - `check_terminology(page: str) → [unknown_term]`: Terms used in a wiki page not found in `glossary.md`.
   - `generate_health_report()`: Run all checks, write `wiki/meta/health.md`.

5. **Search tools** (`vault_mcp/tools/search.py`):
   - `ripgrep_search(query: str, scope: str) → [{path, line, context}]`: Wrapper around `rg` for full-text search. Scope can be `raw`, `wiki`, or `all`.
   - `read_index(topic: str) → str`: Read a topic index file from `wiki/indexes/`.
   - **No vector search.** At personal scale, ripgrep + LLM-maintained indexes + context windows are sufficient. If you outgrow this, add **sqlite-vec** later.

6. **Git tools** (`vault_mcp/tools/git.py`):
   - `auto_commit(message: str)`: Stage all changes in `wiki/` and commit.
   - `get_recent_changes(n: int) → [{hash, message, date}]`: Recent git log for the vault.

**Phase 2: Intelligence — Make it useful**

These are Claude Code workflows that use the MCP tools above.

7. **Query + filing loop** (via `/query` slash command):
   - Claude Code searches the wiki (using `ripgrep_search` + `read_index` tools), reads relevant pages, synthesizes an answer.
   - `/file-answer` writes the answer back to `wiki/answers/` (using `write_wiki_page`) with provenance (which pages were consulted, the original question).

8. **Glossary maintenance**:
   - During compilation, Claude Code proposes new terms via `update_glossary`.
   - During linting, `check_terminology` flags drift.
   - Claude Code always calls `get_glossary` before compiling.

9. **Output generation**:
   - Given a topic, Claude Code compiles a slide deck (Marp format) into `outputs/slides/`.
   - Generate reports synthesizing multiple wiki articles.
   - Produce mermaid diagrams of concept relationships from backlink data.

**Phase 3: Agents — Leverage Claude Code's native capabilities**

8. **Custom subagents** (`.claude/agents/`):
   Define as markdown files with YAML frontmatter. Claude Code spawns these automatically.

   `.claude/agents/compiler.md`:
   ```yaml
   ---
   name: wiki-compiler
   description: Compiles raw sources into wiki pages with summaries, concepts, and backlinks
   tools: Read, Write, Edit, Glob, Grep, Bash, vault:*
   model: sonnet
   ---
   You are a wiki compilation agent for a personal knowledge base.
   
   Workflow:
   1. Call vault:get_changed_sources to find uncompiled/modified sources.
   2. Call vault:get_page_registry and vault:get_glossary for context.
   3. For each changed source, call vault:read_source to get content.
   4. Write summaries and concept articles using vault:write_wiki_page.
   5. Mark processed sources with vault:mark_source_compiled.
   6. Propose new glossary terms with vault:update_glossary.
   7. Commit changes with vault:auto_commit.
   
   Rules:
   - Never generate [[links]] to pages not in the registry.
   - Use consistent terminology from the glossary.
   - Write compilation provenance into frontmatter on every page.
   ```

   `.claude/agents/linter.md`:
   ```yaml
   ---
   name: wiki-linter
   description: Validates wiki integrity — checks links, staleness, terminology, orphans
   tools: Read, Glob, Grep, vault:validate_links, vault:find_stale_pages, vault:find_orphan_pages, vault:find_missing_concepts, vault:generate_health_report
   model: haiku
   ---
   You are a wiki health check agent. Run all validation tools and synthesize
   findings into a clear, actionable health report. Prioritize broken links
   and stale pages as the most critical issues.
   ```

   `.claude/agents/researcher.md`:
   ```yaml
   ---
   name: researcher
   description: Searches the web for information on a topic, ingests relevant sources
   tools: Read, Write, Bash, WebSearch, WebFetch, vault:ingest_url, vault:ingest_text
   model: sonnet
   ---
   You are a research agent. Given a topic:
   1. Search the web for high-quality sources (prefer primary sources, papers, docs)
   2. For each relevant source, ingest it using vault:ingest_url
   3. Write a brief research log to outputs/research-log.md
   ```

9. **Slash commands** (`.claude/commands/`):
   - `/compile $ARGUMENTS` — "Use the vault MCP tools to run incremental compilation. Call get_changed_sources, then compile each changed source into wiki pages. If arguments provided, compile only matching files."
   - `/ingest $ARGUMENTS` — "Ingest the URL or file path using vault:ingest_url or vault:ingest_pdf: $ARGUMENTS"
   - `/query $ARGUMENTS` — "Search the knowledge base using vault:ripgrep_search and vault:read_index, then synthesize an answer for: $ARGUMENTS"
   - `/lint` — "Run wiki health checks using the vault linting tools and report findings."
   - `/file-answer` — "Write the last synthesized answer back to wiki/answers/ using vault:write_wiki_page with full provenance."

10. **Hooks** (`.claude/settings.json`):
    - `PostToolUse` on `vault:write_wiki_page`: auto-run `mdformat` for consistent formatting.
    - `Stop` hook: if the session involved compilation, auto-run lint via `vault:generate_health_report`.

### Technical Constraints

- **Language**: Python 3.12+. Use **uv** for dependency management.
- **Architecture**: Local MCP server (stdio transport) using the **MCP Python SDK** (`mcp`). Claude Code connects to it and does all LLM reasoning. Python code is strictly deterministic — no Anthropic SDK, no direct LLM calls.
- **Billing**: All LLM tokens route through Claude Code → Max subscription. No API key needed. No separate API billing.
- **No vector search infrastructure in Phase 1**: No embeddings, no FAISS, no ChromaDB. Ripgrep + LLM-maintained indexes + context windows. If you later need vector search, use **sqlite-vec** (single .db file, zero dependencies, SQL-native).
- **Markdown**: GitHub-flavored markdown. Frontmatter in YAML via **python-frontmatter**. Internal links use `[[wiki-style]]` double-bracket syntax with alias support (`[[page|display text]]`). Use **mdformat** for output normalization. Use **markdown-it-py** if you need parsing.
- **PDF extraction**: **PyMuPDF4LLM** (fast default), **marker-pdf** (complex papers).
- **Web extraction**: **trafilatura** with `output_format="markdown"`.
- **CLI**: MCP tools are the primary interface (Claude Code calls them). For any standalone CLI needs, use **Typer**. **Rich** for terminal output.
- **Version control**: `git init` the vault. Every compilation auto-commits via the `auto_commit` MCP tool. `.gitignore` for large binary files in `raw/media/`.
- **Config**: `config.yaml` for vault paths, prompt template versions. No API keys needed anywhere.

### What to Build First

Start with this exact sequence:

1. `git init ~/vault` and create the directory structure.
2. Scaffold the MCP server: `vault_mcp/server.py` with stdio transport, register one dummy tool, verify Claude Code can connect to it via `.claude/mcp.json`.
3. Write the ingestion tools: `ingest_url` (trafilatura) and `ingest_pdf` (PyMuPDF4LLM). Test: ingest a URL, verify markdown + frontmatter + content hash land in `raw/inbox/`.
4. Write `wiki/meta/glossary.md` (start empty) and `wiki/meta/page-registry.json` (start as `{"pages": []}`).
5. Write the compilation support tools: `get_changed_sources`, `get_page_registry`, `get_glossary`, `write_wiki_page`, `mark_source_compiled`. Claude Code will use these to compile — you're giving it the plumbing, it does the thinking.
6. Write the linting tools: `validate_links`, `find_stale_pages` at minimum.
7. Write the git tools: `auto_commit`.
8. Wire up the slash commands in `.claude/commands/` and subagent definitions in `.claude/agents/`.
9. Test the full loop: `/ingest <url>` → `/compile` → `/lint` → ask a question → `/file-answer`.

Write tests with **pytest**. The critical invariants to test:
- Ingestion produces valid frontmatter with correct content hashes.
- `get_changed_sources` correctly identifies new/modified sources.
- `validate_links` catches broken `[[links]]`.
- `write_wiki_page` produces valid YAML frontmatter with all required fields.
- `auto_commit` creates clean git commits.
- Content hashes are deterministic (same content → same hash, frontmatter changes don't affect hash).

### Style Preferences

- Clean, well-documented code. Docstrings on all public functions.
- Prefer composition over inheritance.
- No classes where a function will do.
- Type hints everywhere.
- Each MCP tool should be a pure function: structured input → deterministic output. No side effects beyond the intended file operations.
- Rich library for any CLI output.
- Minimal dependencies — don't add libraries until you need them.
