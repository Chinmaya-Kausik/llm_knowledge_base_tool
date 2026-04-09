"""FastAPI web server — thin wrapper over loom tool functions for the UI."""

import json
import os
import sys
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Query, Request, WebSocket
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from loom_mcp.lib.frontmatter import read_frontmatter
from loom_mcp.lib.hashing import content_hash
from loom_mcp.lib.links import parse_links
from loom_mcp.lib.registry import load_registry
from loom_mcp.tools import compile as compile_tools
from loom_mcp.tools import lint as lint_tools
from loom_mcp.tools import search as search_tools

def _resolve_loom_root() -> Path:
    """Resolve loom root: env var > config file > default."""
    if "LOOM_ROOT" in os.environ:
        return Path(os.environ["LOOM_ROOT"])
    config = Path.home() / ".loom-app-config.json"
    if config.exists():
        try:
            data = json.loads(config.read_text())
            if data.get("loom_root"):
                return Path(data["loom_root"])
        except Exception:
            pass
    return Path.home() / "Documents" / "loom"

LOOM_ROOT = _resolve_loom_root()
STATIC_DIR = Path(__file__).resolve().parent / "static"


def bootstrap_loom(loom_root: Path) -> None:
    """Create the loom directory structure if it doesn't exist."""
    dirs = [
        "raw/inbox", "raw/articles", "raw/papers", "raw/repos", "raw/media",
        "wiki/pages", "wiki/meta", "wiki/meta/indexes",
        "wiki/meta/memory",
        "outputs/slides", "outputs/reports", "outputs/visualizations",
    ]
    for d in dirs:
        (loom_root / d).mkdir(parents=True, exist_ok=True)

    # Create page registry if missing
    reg = loom_root / "wiki" / "meta" / "page-registry.json"
    if not reg.exists():
        reg.write_text('{"pages": []}', encoding="utf-8")

    # Create .claude/mcp.json in loom so the agent can find MCP tools
    repo_dir = str(Path(__file__).parent.parent)
    claude_dir = loom_root / ".claude"
    claude_dir.mkdir(exist_ok=True)
    mcp_json = claude_dir / "mcp.json"
    mcp_config = {
        "mcpServers": {
            "loom": {
                "command": "uv",
                "args": ["run", "--directory", repo_dir, "python", "-m", "loom_mcp.server"]
            }
        }
    }
    mcp_json.write_text(json.dumps(mcp_config, indent=2), encoding="utf-8")

    # Copy .claude/settings.json (hooks) if missing
    settings_src = Path(repo_dir) / ".claude" / "settings.json"
    settings_dst = claude_dir / "settings.json"
    if not settings_dst.exists() and settings_src.exists():
        settings_dst.write_text(settings_src.read_text(encoding="utf-8"), encoding="utf-8")

    # Create glossary if missing
    glossary = loom_root / "wiki" / "meta" / "glossary.md"
    if not glossary.exists():
        from loom_mcp.lib.frontmatter import write_frontmatter
        write_frontmatter(glossary, {
            "title": "Glossary", "type": "structure-note", "status": "compiled",
            "created": "2026-04-04", "last_compiled": "2026-04-04T00:00:00Z",
        }, "# Glossary\n\nCanonical terms for the knowledge base.\n")

    # Create CLAUDE.md if missing
    claude_md = loom_root / "CLAUDE.md"
    if not claude_md.exists():
        claude_md.write_text(_LOOM_CLAUDE_MD, encoding="utf-8")

    # Create wiki/meta/conventions.md if missing
    conventions = loom_root / "wiki" / "meta" / "conventions.md"
    if not conventions.exists():
        from loom_mcp.lib.frontmatter import write_frontmatter
        write_frontmatter(conventions, {
            "title": "Conventions",
            "type": "structure-note",
            "status": "compiled",
            "created": "2026-04-07",
        }, _LOOM_CONVENTIONS_CONTENT)

    # Create loom-local config.yaml if missing
    config_yaml = loom_root / "config.yaml"
    if not config_yaml.exists():
        config_yaml.write_text(_LOOM_CONFIG_YAML, encoding="utf-8")


_LOOM_CLAUDE_MD = """\
# Loom

A knowledge base + project workspace on an infinite canvas.

## Structure
- `wiki/` — compiled knowledge (concepts, summaries, indexes, answers, meta)
- `raw/` — ingested sources, chat transcripts
- `projects/` — active code repos, experiments
- `outputs/` — generated artifacts

## Conventions
- Pages are folders with ABOUT.md. Files are subpages.
- Cross-reference with `[[wiki-links]]` (e.g. `[[Attention Mechanisms]]`)
- The master index at `wiki/meta/index.md` catalogs all pages
- Detailed conventions in `wiki/meta/conventions.md`

## Available context
Read these when relevant:
- `wiki/meta/conventions.md` — project conventions and style
- `wiki/meta/index.md` — master index of all pages
- `wiki/meta/glossary.md` — canonical terminology

## Memory
Memories live in `wiki/meta/memory/` as individual files, tagged by project.
Each project folder has a `MEMORY.md` index with one-liners for relevant memories.
A global `MEMORY.md` lives at the loom root for cross-project preferences.
When reading memories from `wiki/meta/memory/`, check the `tags` field in frontmatter to understand which project each memory belongs to. Memories tagged `global` apply everywhere. Memories tagged with a specific project are primarily about that project — they may still be useful in other contexts, but be aware of which project they come from.

When you learn something worth persisting:
1. Create a timestamped file in `wiki/meta/memory/` (e.g. `2026-04-07-uses-typescript.md`)
2. Add frontmatter with `type: memory` and `tags: [project-name]` (or `[global]`)
3. Update the relevant project's `MEMORY.md` with a one-liner
4. For global memories, update the root `MEMORY.md`

## Knowledge during chats
When you discover something during a conversation that would be useful beyond this session, write it to the appropriate place immediately — don't wait for `/compile`:
- **Domain knowledge** (concepts, patterns, insights, resolved confusions) → wiki via `write_wiki_page`
- **Operational context** (project preferences, decisions, conventions) → memory

The distinction: memory = how to work here. Wiki = what things mean.

`/compile` and other tools only interface with the wiki — they process ingested raw sources into wiki pages. Chats are the only place where new knowledge and memories are created from working on projects.

## Tools
- `search_by_tags` — find pages/memories by tag (e.g. `search_by_tags(tags=["my-project"], scope="memory")`)
- `ripgrep_search` — full-text search across the loom
- `read_wiki_page`, `write_wiki_page` — read/write wiki content
"""

_LOOM_CONVENTIONS_CONTENT = """\
# Conventions

## Wiki Pages
- Every wiki page has full YAML frontmatter (title, type, status, created, tags, etc.)
- One concept per article. If a source covers multiple concepts, create multiple articles.
- Internal links use `[[wiki-style]]` double-bracket syntax with optional alias: `[[page|display text]]`
- Canonical terms live in the glossary. Consult it during compilation.

## Compilation
- All wiki pages go in `wiki/pages/` (flat, no subdirectories). Type is in frontmatter, not directory.
- Set confidence (high/medium/low) based on source quality
- Always link back to originating sources in `sources` frontmatter field
- Never generate `[[links]]` to pages not in the page registry

## Folder Pages
- Every folder is a page. Its ABOUT.md holds the content. README.md is a GitHub artifact, not special to loom.
- Folder ABOUT.md explains the folder's purpose, lists key children with descriptions, and shows relationships.
- Updated during `/compile`, not during normal conversation.

## Style
- Type hints everywhere. Docstrings on public functions.
- Prefer functions over classes. Composition over inheritance.
- Each MCP tool: structured input → deterministic output.
"""

_LOOM_CONFIG_YAML = """\
loom:
  root: "."
  raw_dir: "raw"
  wiki_dir: "wiki"
  outputs_dir: "outputs"

frontmatter:
  wiki_required_fields:
    - title
    - type
    - status
    - created

compilation:
  prompt_version: "v1.0"

search:
  default_context_lines: 3

context:
  total_budget_chars: 12000  # ~3000 tokens total for appended system prompt
  memory:
    enabled: true
    max_chars: 2000
  page_content:
    enabled: true
    max_chars: 8000
  folder_readme:
    enabled: true
"""


@asynccontextmanager
async def lifespan(app):
    bootstrap_loom(LOOM_ROOT)
    yield


app = FastAPI(title="Loom Knowledge Base", lifespan=lifespan)


# --- Graph builder (folder-as-page model) ---

def _old_build_graph(loom_root: Path) -> dict[str, Any]:
    """DEPRECATED: old registry-based graph. Kept for reference."""
    registry_path = loom_root / "wiki" / "meta" / "page-registry.json"
    registry = load_registry(registry_path)

    # Build lookup: lowercase title/alias → page path
    title_to_path: dict[str, str] = {}
    for page in registry.get("pages", []):
        title_to_path[page["title"].lower()] = page["path"]
        for alias in page.get("aliases", []):
            title_to_path[alias.lower()] = page["path"]

    nodes = []
    edges = []
    edge_set: set[tuple[str, str]] = set()

    for page in registry.get("pages", []):
        page_path = page["path"]
        full_path = loom_root / page_path

        # Defaults
        node_data: dict[str, Any] = {
            "id": page_path,
            "label": page["title"],
            "type": "unknown",
            "status": "unknown",
            "tags": [],
            "confidence": "medium",
            "folder": str(Path(page_path).parent),
            "linkCount": 0,
            "parent": None,
            "children": [],
        }

        if full_path.exists():
            try:
                metadata, content = read_frontmatter(full_path)
                node_data["type"] = metadata.get("type", "unknown")
                node_data["status"] = metadata.get("status", "unknown")
                node_data["tags"] = metadata.get("tags", [])
                node_data["confidence"] = metadata.get("confidence", "medium")
                node_data["sources"] = metadata.get("sources", [])

                # Resolve parent field
                parent_raw = metadata.get("parent", "")
                if parent_raw:
                    parent_links = parse_links(parent_raw)
                    if parent_links:
                        parent_path = title_to_path.get(parent_links[0].target.lower())
                        if parent_path:
                            node_data["parent"] = parent_path

                # Parse outbound links
                links = parse_links(content)
                # Also parse links from related field
                for related in metadata.get("related", []):
                    links.extend(parse_links(related))

                outbound = 0
                for link in links:
                    target_path = title_to_path.get(link.target.lower())
                    if target_path and target_path != page_path:
                        edge_key = (page_path, target_path)
                        if edge_key not in edge_set:
                            edge_set.add(edge_key)
                            edges.append({
                                "data": {
                                    "source": page_path,
                                    "target": target_path,
                                    "label": link.target,
                                }
                            })
                            outbound += 1
                node_data["linkCount"] = outbound
            except Exception:
                pass

        nodes.append({"data": node_data})

    # Update linkCount to include inbound links
    inbound_count: dict[str, int] = {}
    for edge in edges:
        target = edge["data"]["target"]
        inbound_count[target] = inbound_count.get(target, 0) + 1

    # Build children lists from parent fields
    node_map: dict[str, dict] = {}
    for node in nodes:
        nid = node["data"]["id"]
        node["data"]["linkCount"] = node["data"].get("linkCount", 0) + inbound_count.get(nid, 0)
        node_map[nid] = node["data"]

    for node in nodes:
        parent = node["data"].get("parent")
        if parent and parent in node_map:
            node_map[parent]["children"].append(node["data"]["id"])

    # --- Build top-level view with aggregated edges ---

    def get_top_ancestor(path: str) -> str:
        """Walk parent links to find the top-level ancestor."""
        visited = set()
        current = path
        while current in node_map and node_map[current].get("parent") and current not in visited:
            visited.add(current)
            current = node_map[current]["parent"]
        return current

    top_nodes = [n for n in nodes if not n["data"].get("parent")]

    # Aggregate edges: lift both endpoints to their top-level ancestors
    top_edge_set: set[tuple[str, str]] = set()
    top_edges = []
    for edge in edges:
        src_top = get_top_ancestor(edge["data"]["source"])
        tgt_top = get_top_ancestor(edge["data"]["target"])
        if src_top == tgt_top:
            continue  # Internal edge within same parent hierarchy
        key = (src_top, tgt_top)
        if key not in top_edge_set:
            top_edge_set.add(key)
            top_edges.append({
                "data": {"source": src_top, "target": tgt_top}
            })

    return {
        "nodes": nodes,
        "edges": edges,
        "top_nodes": top_nodes,
        "top_edges": top_edges,
    }


def build_tree(loom_root: Path) -> dict[str, Any]:
    """Build a folder tree structure of wiki/."""
    wiki_dir = loom_root / "wiki"

    def walk(directory: Path) -> list[dict]:
        children = []
        if not directory.exists():
            return children
        for item in sorted(directory.iterdir()):
            rel = str(item.relative_to(loom_root))
            if item.is_dir():
                kids = walk(item)
                children.append({"id": rel, "name": item.name, "type": "folder", "children": kids})
            elif item.suffix == ".md":
                # Try to read title from frontmatter
                title = item.stem
                try:
                    meta, _ = read_frontmatter(item)
                    title = meta.get("title", item.stem)
                except Exception:
                    pass
                children.append({"id": rel, "name": item.name, "title": title, "type": "file"})
        return children

    return {"id": "wiki", "name": "wiki", "type": "folder", "children": walk(wiki_dir)}


def build_provenance(loom_root: Path) -> dict[str, Any]:
    """Build a provenance graph: raw sources → wiki pages."""
    wiki_dir = loom_root / "wiki"
    raw_sources: dict[str, dict] = {}
    wiki_nodes = []
    edges = []

    for md_file in wiki_dir.rglob("*.md"):
        try:
            metadata, _ = read_frontmatter(md_file)
        except Exception:
            continue

        rel = str(md_file.relative_to(loom_root))
        wiki_nodes.append({
            "data": {
                "id": rel,
                "label": metadata.get("title", md_file.stem),
                "nodeType": "wiki",
                "pageType": metadata.get("type", "unknown"),
            }
        })

        for src in metadata.get("sources", []):
            src_path = src.get("path", "")
            if src_path:
                if src_path not in raw_sources:
                    # Try to get title
                    src_title = Path(src_path).stem
                    full_src = loom_root / src_path
                    if full_src.exists():
                        try:
                            src_meta, _ = read_frontmatter(full_src)
                            src_title = src_meta.get("title", src_title)
                        except Exception:
                            pass
                    raw_sources[src_path] = {
                        "data": {
                            "id": src_path,
                            "label": src_title,
                            "nodeType": "raw",
                        }
                    }
                edges.append({
                    "data": {"source": src_path, "target": rel}
                })

    nodes = list(raw_sources.values()) + wiki_nodes
    return {"nodes": nodes, "edges": edges}


# --- New graph builder (folder-as-page) ---

def build_graph_v2(loom_root: Path, show_internals: bool = False) -> dict[str, Any]:
    """Build page graph using folder-as-page model."""
    from loom_mcp.lib.pages import build_page_graph, get_page_content, FILETYPE_CATEGORIES
    graph = build_page_graph(loom_root, show_internals=show_internals)

    # Convert to frontend-compatible format
    def page_to_node(p):
        return {"data": {
            "id": p["id"], "label": p["title"], "path": p["path"],
            "is_folder": p["is_folder"], "parent_id": p["parent_id"],
            "children": p["children_ids"], "type": p["type"],
            "category": p["category"], "status": p["status"],
            "tags": p["tags"], "confidence": p["confidence"],
            "has_readme": p.get("has_readme", False),
        }}

    return {
        "nodes": [page_to_node(p) for p in graph["pages"]],
        "edges": [{"data": e} for e in graph["edges"]],
        "top_nodes": [page_to_node(p) for p in graph["top_pages"]],
        "top_edges": [{"data": e} for e in graph["top_edges"]],
        "filetype_categories": FILETYPE_CATEGORIES,
    }


def build_tree_v2(loom_root: Path, show_internals: bool = False, include_hidden: bool = False) -> dict[str, Any]:
    """Build folder tree using the new page model."""
    from loom_mcp.lib.pages import walk_pages
    pages = walk_pages(loom_root, include_hidden=include_hidden, show_internals=show_internals)

    # Build nested tree from flat page list
    page_map = {p["id"]: {**p, "children": []} for p in pages}
    roots = []

    for p in pages:
        node = page_map[p["id"]]
        if p["parent_id"] is None:
            roots.append(node)
        elif p["parent_id"] in page_map:
            page_map[p["parent_id"]]["children"].append(node)

    def simplify(node):
        p = loom_root / node["path"]
        try:
            stat = p.stat() if p.exists() else None
        except OSError:
            stat = None
        return {
            "id": node["id"],
            "name": Path(node["path"]).name,
            "title": node["title"],
            "type": "folder" if node["is_folder"] else "file",
            "category": node["category"],
            "children": [simplify(c) for c in node["children"]] if node["is_folder"] else [],
            "mtime": stat.st_mtime if stat else 0,
            "ctime": stat.st_birthtime if stat and hasattr(stat, 'st_birthtime') else (stat.st_ctime if stat else 0),
        }

    return {"id": "", "name": "loom", "type": "folder", "children": [simplify(r) for r in roots]}


# --- Helpers ---

def _serialize(obj: Any) -> Any:
    """Make objects JSON-serializable."""
    if hasattr(obj, "isoformat"):
        return obj.isoformat()
    if isinstance(obj, Path):
        return str(obj)
    return obj


def _serialize_dict(d: dict) -> dict:
    return {k: _serialize(v) for k, v in d.items()}


# --- API Endpoints ---

@app.get("/api/children/{path:path}")
def api_children(path: str, show_internals: bool = False):
    """Get immediate children of a folder (for lazy-loading on drill-in)."""
    from loom_mcp.lib.pages import walk_pages, get_page_content, get_page_metadata, get_page_title, is_hidden, is_loom_internal, get_filetype_category
    full_path = (LOOM_ROOT / path).resolve()
    loom_resolved = LOOM_ROOT.resolve()
    if not str(full_path).startswith(str(loom_resolved)) or not full_path.is_dir():
        raise HTTPException(404, "Not a folder")

    children = []
    try:
        items = sorted(full_path.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower()))
    except (PermissionError, OSError):
        return {"children": []}

    for item in items:
        if is_hidden(item):
            continue
        if not show_internals and is_loom_internal(item):
            continue
        if item.is_symlink():
            continue
        if item.name in ("ABOUT.md", "MEMORY.md"):
            continue

        rel = str(item.relative_to(LOOM_ROOT))
        meta = get_page_metadata(item)
        content = get_page_content(item) if item.is_dir() or item.suffix == ".md" else ""

        children.append({
            "data": {
                "id": rel,
                "label": item.name,
                "path": rel,
                "is_folder": item.is_dir(),
                "parent_id": path,
                "children": [],
                "type": meta.get("type", "folder" if item.is_dir() else get_filetype_category(item)),
                "category": "folder" if item.is_dir() else get_filetype_category(item),
                "status": meta.get("status", ""),
                "tags": meta.get("tags", []),
                "has_readme": (item / "ABOUT.md").exists() if item.is_dir() else False,
                "content": content[:8000] if content else "",
            }
        })

    return {"children": children}


@app.get("/api/graph")
def api_graph(show_internals: bool = False):
    return build_graph_v2(LOOM_ROOT, show_internals=show_internals)


@app.get("/api/provenance")
def api_provenance():
    return build_provenance(LOOM_ROOT)


@app.get("/api/registry")
def api_registry():
    return compile_tools.get_page_registry(LOOM_ROOT)


@app.get("/api/page/{path:path}")
def api_page(path: str):
    from loom_mcp.lib.pages import get_page_content, get_page_metadata
    full_path = LOOM_ROOT / path
    if not full_path.exists():
        raise HTTPException(status_code=404, detail=f"Page not found: {path}")
    content = get_page_content(full_path)
    metadata = get_page_metadata(full_path)
    return {"frontmatter": _serialize_dict(metadata), "content": content}


@app.post("/api/pages/bulk")
async def api_pages_bulk(request: Request):
    """Fetch multiple pages in a single request for faster loading."""
    from loom_mcp.lib.pages import get_page_content, get_page_metadata
    paths = await request.json()
    if not isinstance(paths, list):
        raise HTTPException(status_code=400, detail="Expected JSON array")
    result = {}
    for path in paths:
        full_path = LOOM_ROOT / path
        if full_path.exists():
            content = get_page_content(full_path)
            metadata = get_page_metadata(full_path)
            result[path] = {"frontmatter": _serialize_dict(metadata), "content": content}
        else:
            result[path] = None
    return result


@app.get("/api/tree")
def api_tree(show_internals: bool = False, include_hidden: bool = False):
    return build_tree_v2(LOOM_ROOT, show_internals=show_internals, include_hidden=include_hidden)


@app.get("/api/search")
def api_search(q: str = Query(...), scope: str = Query("all"), file_glob: str = Query("*"), mode: str = Query("both")):
    """Search loom. mode: 'content', 'name', or 'both' (default)."""
    results = []
    try:
        if mode in ("name", "both"):
            results.extend(search_tools.filename_search(LOOM_ROOT, q, scope))
        if mode in ("content", "both"):
            results.extend(search_tools.ripgrep_search(LOOM_ROOT, q, scope, file_glob=file_glob))
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e))
    return results


@app.get("/api/health")
def api_health():
    return lint_tools.generate_health_report(LOOM_ROOT)


@app.get("/api/glossary")
def api_glossary():
    return {"content": compile_tools.get_glossary(LOOM_ROOT)}


@app.get("/api/broken-links")
def api_broken_links():
    return lint_tools.validate_links(LOOM_ROOT)


@app.get("/api/orphans")
def api_orphans():
    return lint_tools.find_orphan_pages(LOOM_ROOT)


@app.get("/api/stale")
def api_stale():
    return lint_tools.find_stale_pages(LOOM_ROOT)


# --- Layout persistence ---

LAYOUT_FILE = LOOM_ROOT / "wiki" / "meta" / "canvas-layout.json"


@app.get("/api/layout")
def api_get_layout():
    if LAYOUT_FILE.exists():
        try:
            return json.loads(LAYOUT_FILE.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            pass
    return {}


@app.put("/api/layout")
async def api_save_layout(request: Request):
    data = await request.json()
    LAYOUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    LAYOUT_FILE.write_text(json.dumps(data, indent=2), encoding="utf-8")
    return {"ok": True}


# --- Page editing ---

@app.put("/api/page/{path:path}")
async def api_update_page(path: str, request: Request):
    """Update a wiki page's content (and optionally frontmatter)."""
    body = await request.json()
    page_frontmatter = body.get("frontmatter", {})
    content = body.get("content", "")

    full_path = LOOM_ROOT / path
    if not full_path.exists():
        raise HTTPException(status_code=404, detail=f"Page not found: {path}")

    from loom_mcp.lib.frontmatter import write_frontmatter
    write_frontmatter(full_path, page_frontmatter, content)
    return {"ok": True, "path": path}


# --- Settings ---

@app.get("/api/settings")
def api_get_settings():
    import subprocess
    # Check Claude auth status
    auth_check = subprocess.run(["claude", "auth", "status"], capture_output=True, text=True)
    authenticated = auth_check.returncode == 0
    return {"loom_root": str(LOOM_ROOT), "claude_authenticated": authenticated}


@app.post("/api/claude-auth")
async def api_claude_auth():
    """Trigger Claude auth login via browser OAuth."""
    import subprocess
    # Check if already authenticated
    check = subprocess.run(["claude", "auth", "status"], capture_output=True, text=True, timeout=5)
    if check.returncode == 0:
        return {"message": "Already authenticated."}
    # Open browser-based auth
    try:
        subprocess.Popen(["claude", "auth", "login"])
        return {"message": "Browser opened for login. Complete auth there, then come back."}
    except FileNotFoundError:
        return {"error": "Claude CLI not found. Install it first: npm install -g @anthropic-ai/claude-code"}
    except Exception as e:
        return {"error": f"Failed: {e}"}


@app.put("/api/settings")
async def api_update_settings(request: Request):
    body = await request.json()
    new_root = body.get("loom_root")
    if not new_root:
        return {"ok": False, "error": "No loom_root provided"}

    if not new_root.startswith("/") and not new_root.startswith("~"):
        return {"ok": False, "error": f"Path must be absolute (got '{new_root}'). Did you mean '/{new_root}'?"}
    root_path = Path(new_root).expanduser().resolve()
    if not root_path.exists():
        return {"ok": False, "error": f"Path does not exist: {root_path}"}
    if not root_path.is_dir():
        return {"ok": False, "error": f"Path is not a directory: {root_path}"}

    # Write to config file so it persists across restarts
    config_path = Path.home() / ".loom-app-config.json"
    config_path.write_text(json.dumps({"loom_root": str(root_path)}), encoding="utf-8")
    # Also update the env var so a restart within this process picks it up
    os.environ["LOOM_ROOT"] = str(root_path)
    return {"ok": True, "loom_root": str(root_path)}


@app.post("/api/restart")
async def api_restart():
    """Full process restart — re-exec the server so code changes take effect.

    Responds with OK, then a background thread replaces the process after a delay.
    Skips the actual os.execv when running under pytest (detected by sys.argv).
    """
    import threading

    def _restart():
        import time
        time.sleep(0.5)  # Let the HTTP response flush
        # Skip actual restart in test mode
        if "pytest" in sys.argv[0] or "pytest" in sys.modules:
            return
        print(f"[restart] os.execv: {sys.executable} {sys.argv}", flush=True)
        os.execv(sys.executable, [sys.executable] + sys.argv)

    threading.Thread(target=_restart, daemon=True).start()
    return {"ok": True, "restarting": True}


# --- Chat transcript saving ---

@app.post("/api/chat/append")
async def api_append_chat(request: Request):
    """Append new messages to an existing chat transcript."""
    body = await request.json()
    rel_path = body.get("path", "")
    messages = body.get("messages", [])
    if not rel_path or not messages:
        return {"ok": False, "error": "Missing path or messages"}

    full_path = (LOOM_ROOT / rel_path).resolve()
    chats_dir = (LOOM_ROOT / "raw" / "chats").resolve()
    if not str(full_path).startswith(str(chats_dir)):
        return {"ok": False, "error": "Invalid path"}
    if not full_path.exists():
        return {"ok": False, "error": "File not found"}

    from datetime import datetime, timezone
    from loom_mcp.tools.compile import _render_messages

    now = datetime.now()  # Local timezone
    lines = [
        "",
        f"---",
        f"*Continued: {now.strftime('%Y-%m-%d %H:%M')}*",
        "",
    ]
    lines.extend(_render_messages(messages))

    try:
        with open(full_path, "a", encoding="utf-8") as f:
            f.write("\n".join(lines))
        return {"ok": True}
    except Exception as e:
        return {"ok": False, "error": str(e)}


@app.post("/api/chat/save")
async def api_save_chat(request: Request):
    """Save a chat transcript to raw/chats/."""
    body = await request.json()
    session_id = body.get("session_id", "unknown")
    messages = body.get("messages", [])
    title = body.get("title")  # LLM-generated title if available
    context_path = body.get("context_path")  # Page/project the chat was in
    if not messages:
        return {"ok": False, "error": "No messages to save"}

    # Get precompact files from session if available
    from loom_mcp.chat import sessions as chat_sessions
    session = chat_sessions.get(session_id, {})
    precompact_files = session.get("precompact_files", [])

    from loom_mcp.tools.compile import save_chat_transcript
    result = save_chat_transcript(LOOM_ROOT, session_id, messages, title=title,
                                  context_path=context_path, precompact_files=precompact_files)
    return {"ok": True, **result}


@app.post("/api/chat/generate-title")
async def api_generate_chat_title(request: Request):
    """Generate a title and filename slug for a chat using Haiku.

    Expects: {messages: [{role, content}, ...]} — first 2-3 exchanges.
    Returns: {ok, title, slug} or {ok: false, error}.
    """
    body = await request.json()
    messages = body.get("messages", [])
    if not messages:
        return {"ok": False, "error": "No messages"}

    # Build a concise summary of the conversation start
    summary_parts = []
    for msg in messages[:6]:  # Max 3 exchanges (user+assistant)
        role = msg.get("role", "")
        content = msg.get("content", "")
        if role in ("user", "assistant") and content:
            label = "User" if role == "user" else "Assistant"
            summary_parts.append(f"{label}: {content[:300]}")

    if not summary_parts:
        return {"ok": False, "error": "No user/assistant messages"}

    conversation = "\n\n".join(summary_parts)

    try:
        from claude_agent_sdk import ClaudeAgentOptions, ResultMessage, query

        prompt = f"""Based on this conversation start, generate:
1. A descriptive title (5-8 words, like a document heading)
2. A filename slug (2-4 words, lowercase, hyphenated)

Conversation:
{conversation}

Respond in exactly this format, nothing else:
TITLE: <title here>
SLUG: <slug here>"""

        title = None
        slug = None

        async for event in query(
            prompt=prompt,
            options=ClaudeAgentOptions(
                cwd=str(LOOM_ROOT),
                permission_mode="auto",
                model="haiku",
                max_turns=1,
            ),
        ):
            if isinstance(event, ResultMessage):
                result_text = getattr(event, "result", "") or ""
                for line in result_text.strip().split("\n"):
                    line = line.strip()
                    if line.startswith("TITLE:"):
                        title = line[6:].strip()
                    elif line.startswith("SLUG:"):
                        slug = line[5:].strip().lower().replace(" ", "-")

        if title and slug:
            # Sanitize slug
            slug = "".join(c if c.isalnum() or c == "-" else "" for c in slug)
            return {"ok": True, "title": title, "slug": slug}
        return {"ok": False, "error": "Could not parse LLM response"}

    except Exception as e:
        return {"ok": False, "error": str(e)}


@app.post("/api/chat/update-title")
async def api_update_chat_title(request: Request):
    """Update a saved chat transcript's heading after async title generation.

    Expects: {path: "raw/chats/file.md", title: "New Title"}
    Replaces the first `# ...` heading line with `# New Title`.
    """
    body = await request.json()
    rel_path = body.get("path", "")
    title = body.get("title", "")
    if not rel_path or not title:
        return {"ok": False, "error": "Missing path or title"}

    full_path = (LOOM_ROOT / rel_path).resolve()
    chats_dir = (LOOM_ROOT / "raw" / "chats").resolve()
    if not str(full_path).startswith(str(chats_dir)):
        return {"ok": False, "error": "Invalid path"}
    if not full_path.exists():
        return {"ok": False, "error": "File not found"}

    try:
        content = full_path.read_text(encoding="utf-8")
        lines = content.split("\n")
        # Replace the first heading line
        for i, line in enumerate(lines):
            if line.startswith("# "):
                lines[i] = f"# {title}"
                break
        full_path.write_text("\n".join(lines), encoding="utf-8")
        return {"ok": True}
    except Exception as e:
        return {"ok": False, "error": str(e)}


# --- File operations ---

@app.post("/api/compile-tex")
async def api_compile_tex(request: Request):
    """Compile a .tex file to PDF using latexmk.

    Expects: {path: "projects/paper/paper.tex"}
    Returns: {ok, pdf_path} or {ok: false, error, log}
    """
    import subprocess

    body = await request.json()
    rel_path = body.get("path", "")
    if not rel_path or not rel_path.endswith(".tex"):
        return {"ok": False, "error": "Not a .tex file"}

    full_path = (LOOM_ROOT / rel_path).resolve()
    loom_resolved = LOOM_ROOT.resolve()
    if not str(full_path).startswith(str(loom_resolved)):
        return {"ok": False, "error": "Path outside loom"}
    if not full_path.exists():
        return {"ok": False, "error": "File not found"}

    tex_dir = full_path.parent
    try:
        result = subprocess.run(
            ["latexmk", "-pdf", "-interaction=nonstopmode", "-halt-on-error", full_path.name],
            cwd=str(tex_dir),
            capture_output=True,
            text=True,
            timeout=60,
        )

        pdf_name = full_path.stem + ".pdf"
        pdf_path = tex_dir / pdf_name

        if pdf_path.exists():
            pdf_rel = str(pdf_path.relative_to(LOOM_ROOT))
            return {"ok": True, "pdf_path": pdf_rel}
        else:
            # Compilation failed — return last 50 lines of log
            log_lines = result.stdout.split("\n")[-50:] if result.stdout else []
            return {"ok": False, "error": "Compilation failed", "log": "\n".join(log_lines)}

    except subprocess.TimeoutExpired:
        return {"ok": False, "error": "Compilation timed out (60s)"}
    except FileNotFoundError:
        return {"ok": False, "error": "latexmk not found — install TeX Live"}
    except Exception as e:
        return {"ok": False, "error": str(e)}


@app.post("/api/mkdir")
async def api_mkdir(request: Request):
    """Create a new directory in the loom."""
    body = await request.json()
    rel_path = body.get("path", "")
    if not rel_path:
        return {"ok": False, "error": "No path"}
    full_path = (LOOM_ROOT / rel_path).resolve()
    if not str(full_path).startswith(str(LOOM_ROOT.resolve())):
        return {"ok": False, "error": "Invalid path"}
    try:
        full_path.mkdir(parents=True, exist_ok=True)
        # Create ABOUT.md for the folder
        readme = full_path / "ABOUT.md"
        if not readme.exists():
            readme.write_text(f"# {full_path.name}\n\n", encoding="utf-8")
        return {"ok": True}
    except Exception as e:
        return {"ok": False, "error": str(e)}


@app.post("/api/delete")
async def api_delete(request: Request):
    """Delete a file or empty folder from the loom."""
    body = await request.json()
    rel_path = body.get("path", "")
    if not rel_path:
        return {"ok": False, "error": "No path"}
    full_path = (LOOM_ROOT / rel_path).resolve()
    if not str(full_path).startswith(str(LOOM_ROOT.resolve())):
        return {"ok": False, "error": "Invalid path"}
    if not full_path.exists():
        return {"ok": False, "error": "File not found"}
    try:
        if full_path.is_file():
            full_path.unlink()
        elif full_path.is_dir():
            import shutil
            shutil.rmtree(full_path)
        return {"ok": True}
    except Exception as e:
        return {"ok": False, "error": str(e)}


# --- Plan file API ---

@app.get("/api/plan")
async def api_get_plan():
    """Get the current plan file content."""
    plans_dir = LOOM_ROOT / ".claude" / "plans"
    if not plans_dir.exists():
        return {"ok": False, "error": "No plans directory"}
    # Find the most recent plan file
    plan_files = sorted(plans_dir.glob("*.md"), key=lambda f: f.stat().st_mtime, reverse=True)
    if not plan_files:
        return {"ok": False, "error": "No plan files"}
    plan = plan_files[0]
    return {"ok": True, "path": str(plan.relative_to(LOOM_ROOT)), "content": plan.read_text(encoding="utf-8")}


def _validate_plan_path(path: str) -> Path | None:
    """Resolve and validate a plan file path, preventing traversal attacks."""
    if not path:
        return None
    full_path = (LOOM_ROOT / path).resolve()
    plans_dir = (LOOM_ROOT / ".claude" / "plans").resolve()
    if not str(full_path).startswith(str(plans_dir)):
        return None
    return full_path


@app.put("/api/plan")
async def api_put_plan(request: Request):
    """Update the current plan file content."""
    body = await request.json()
    full_path = _validate_plan_path(body.get("path", ""))
    if not full_path or not full_path.exists():
        return {"ok": False, "error": "Invalid plan path"}
    full_path.write_text(body.get("content", ""), encoding="utf-8")
    return {"ok": True}


@app.delete("/api/plan")
async def api_delete_plan(request: Request):
    """Delete a plan file after approval."""
    body = await request.json()
    full_path = _validate_plan_path(body.get("path", ""))
    if not full_path or not full_path.exists():
        return {"ok": False, "error": "Invalid plan path"}
    full_path.unlink()
    return {"ok": True}


# --- System open ---

@app.post("/api/open-external")
async def api_open_external(request: Request):
    """Open a file in the system's default application."""
    import subprocess
    body = await request.json()
    path = body.get("path", "")
    if not path:
        return {"ok": False, "error": "No path"}
    full_path = (LOOM_ROOT / path).resolve()
    if not str(full_path).startswith(str(LOOM_ROOT.resolve())):
        return {"ok": False, "error": "Invalid path"}
    if not full_path.exists():
        return {"ok": False, "error": "File not found"}
    subprocess.Popen(["open", str(full_path)])
    return {"ok": True}


# --- Chat WebSocket ---

@app.websocket("/ws/chat")
async def websocket_chat(websocket: WebSocket):
    from loom_mcp.chat import ws_chat
    await ws_chat(websocket, LOOM_ROOT)


# --- Terminal WebSocket ---

@app.websocket("/ws/terminal")
async def websocket_terminal(websocket: WebSocket):
    import os, fcntl, asyncio, traceback
    from ptyprocess import PtyProcess
    from starlette.websockets import WebSocketDisconnect

    try:
        await websocket.accept()
        print("[TERM] accepted", flush=True)

        shell = os.environ.get("SHELL", "/bin/zsh")
        proc = PtyProcess.spawn([shell, "-l"], cwd=str(LOOM_ROOT))
        print(f"[TERM] spawned pid={proc.pid}", flush=True)

        fcntl.fcntl(proc.fd, fcntl.F_SETFL, os.O_NONBLOCK)

        async def read_pty():
            print("[TERM] read_pty started", flush=True)
            while proc.isalive():
                await asyncio.sleep(0.01)
                try:
                    data = os.read(proc.fd, 4096)
                    if data:
                        await websocket.send_bytes(data)
                except BlockingIOError:
                    pass
                except OSError:
                    if not proc.isalive():
                        break
            print("[TERM] read_pty ended", flush=True)

        read_task = asyncio.create_task(read_pty())

        while True:
            msg = await websocket.receive()
            if msg["type"] == "websocket.receive":
                if "bytes" in msg:
                    os.write(proc.fd, msg["bytes"])
                elif "text" in msg:
                    text = msg["text"]
                    if text.startswith("RESIZE:"):
                        try:
                            _, cols, rows = text.split(":")
                            proc.setwinsize(int(rows), int(cols))
                        except Exception:
                            pass
                    else:
                        os.write(proc.fd, text.encode())
            elif msg["type"] == "websocket.disconnect":
                break

    except WebSocketDisconnect:
        print("[TERM] ws disconnect", flush=True)
    except Exception as e:
        print(f"[TERM] ERROR: {e}", flush=True)
        traceback.print_exc()
    finally:
        try:
            read_task.cancel()
        except Exception:
            pass
        try:
            if proc.isalive():
                proc.terminate(force=True)
        except Exception:
            pass
        print("[TERM] cleaned up", flush=True)


# --- Media serving (downloaded images) ---

@app.get("/media/{filepath:path}")
def serve_media(filepath: str):
    """Serve any file from the loom (for PDFs, images, etc.)."""
    full_path = LOOM_ROOT / filepath
    if not full_path.exists():
        # Fallback to raw/media/ for backward compat
        full_path = LOOM_ROOT / "raw" / "media" / filepath
    if not full_path.exists():
        raise HTTPException(status_code=404, detail="File not found")
    return FileResponse(str(full_path))


# --- Static file serving ---

app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


@app.middleware("http")
async def no_cache_static(request: Request, call_next):
    """Disable browser caching for static files during development."""
    response = await call_next(request)
    if request.url.path.startswith("/static") or request.url.path == "/":
        response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
    return response


@app.get("/")
def index():
    return FileResponse(str(STATIC_DIR / "index.html"))


# --- Entrypoint ---

def main():
    """Run the web UI server."""
    import uvicorn
    port = int(os.environ.get("LOOM_PORT", "8420"))
    print(f"Starting Loom UI at http://localhost:{port}")
    uvicorn.run(app, host="127.0.0.1", port=port)


if __name__ == "__main__":
    main()
