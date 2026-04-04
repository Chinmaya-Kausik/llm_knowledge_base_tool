# Vault — Personal Knowledge Base

## What This Is

A local-first personal knowledge management system. Markdown files + Claude Code as the primary interaction layer. No cloud sync, no proprietary formats.

## Architecture

- **All LLM reasoning routes through Claude Code** (Max subscription). Python tooling is a local MCP server providing deterministic, non-LLM tools.
- **No Anthropic SDK calls from Python.** No API key needed. Claude Code calls MCP tools, does the thinking, writes wiki pages.
- **MCP server**: `vault_mcp/` — stdio transport, registered in `.claude/mcp.json`.

## Directory Layout

- `raw/` — unprocessed source material (articles, papers, repos, media, inbox)
- `wiki/` — LLM-compiled structured knowledge (concepts, summaries, indexes, answers, meta)
- `outputs/` — generated artifacts (slides, reports, visualizations)
- `vault_mcp/` — MCP server code (tools + lib)

## Key Conventions

- Every wiki page MUST have full YAML frontmatter (see `config.yaml` for required fields).
- Internal links use `[[wiki-style]]` double-bracket syntax with optional alias: `[[page|display text]]`.
- Canonical terms live in `wiki/meta/glossary.md`. Always consult it during compilation.
- `wiki/meta/page-registry.json` tracks all wiki pages. Never generate `[[links]]` to pages not in the registry.
- Content hashes are SHA-256 of content body (excluding frontmatter).

## Workflows

- `/ingest <url>` — capture a URL into `raw/inbox/`
- `/compile` — incrementally compile changed raw sources into wiki pages
- `/query <question>` — search wiki + synthesize answer
- `/lint` — run health checks
- `/file-answer` — write last synthesized answer back to `wiki/answers/`

## Web UI

A visual knowledge base explorer at `http://localhost:8420`. Launch with:

```bash
VAULT_ROOT=/path/to/vault uv run --extra web python -m vault_mcp.web
```

Views: Graph (force-directed), Tree, Tags, Provenance, Health Dashboard, Search.
Draggable/resizable/maximizable document windows with clickable `[[wiki-links]]`.

## Configuration

Set `VAULT_ROOT` env var to point at your vault directory. Defaults to the repo root.
The data directories (`raw/`, `wiki/`, `outputs/`) are gitignored.

## Tech Stack

- Python 3.12+, managed with `uv`
- MCP Python SDK (stdio transport)
- trafilatura (web extraction), PyMuPDF4LLM (PDF extraction)
- python-frontmatter, mdformat, pytest
- ripgrep for search (via subprocess)

## Style

- Type hints everywhere. Docstrings on public functions.
- Prefer functions over classes. Composition over inheritance.
- Each MCP tool: structured input → deterministic output.
- No vector search. Ripgrep + LLM-maintained indexes + context windows.
