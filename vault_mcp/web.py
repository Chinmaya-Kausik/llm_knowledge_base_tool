"""FastAPI web server — thin wrapper over vault tool functions for the UI."""

import json
import os
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Query, Request, WebSocket
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from vault_mcp.lib.frontmatter import read_frontmatter
from vault_mcp.lib.hashing import content_hash
from vault_mcp.lib.links import parse_links
from vault_mcp.lib.registry import load_registry
from vault_mcp.tools import compile as compile_tools
from vault_mcp.tools import lint as lint_tools
from vault_mcp.tools import search as search_tools

VAULT_ROOT = Path(os.environ.get("VAULT_ROOT", Path(__file__).resolve().parent.parent))
STATIC_DIR = Path(__file__).resolve().parent / "static"


def bootstrap_vault(vault_root: Path) -> None:
    """Create the vault directory structure if it doesn't exist."""
    dirs = [
        "raw/inbox", "raw/articles", "raw/papers", "raw/repos", "raw/media",
        "wiki/concepts", "wiki/summaries", "wiki/indexes", "wiki/answers", "wiki/meta",
        "outputs/slides", "outputs/reports", "outputs/visualizations",
    ]
    for d in dirs:
        (vault_root / d).mkdir(parents=True, exist_ok=True)

    # Create page registry if missing
    reg = vault_root / "wiki" / "meta" / "page-registry.json"
    if not reg.exists():
        reg.write_text('{"pages": []}', encoding="utf-8")

    # Create glossary if missing
    glossary = vault_root / "wiki" / "meta" / "glossary.md"
    if not glossary.exists():
        from vault_mcp.lib.frontmatter import write_frontmatter
        write_frontmatter(glossary, {
            "title": "Glossary", "type": "structure-note", "status": "compiled",
            "created": "2026-04-04", "last_compiled": "2026-04-04T00:00:00Z",
        }, "# Glossary\n\nCanonical terms for the knowledge base.\n")


@asynccontextmanager
async def lifespan(app):
    bootstrap_vault(VAULT_ROOT)
    yield


app = FastAPI(title="Vault Knowledge Base", lifespan=lifespan)


# --- Graph builder (folder-as-page model) ---

def _old_build_graph(vault_root: Path) -> dict[str, Any]:
    """DEPRECATED: old registry-based graph. Kept for reference."""
    registry_path = vault_root / "wiki" / "meta" / "page-registry.json"
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
        full_path = vault_root / page_path

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


def build_tree(vault_root: Path) -> dict[str, Any]:
    """Build a folder tree structure of wiki/."""
    wiki_dir = vault_root / "wiki"

    def walk(directory: Path) -> list[dict]:
        children = []
        if not directory.exists():
            return children
        for item in sorted(directory.iterdir()):
            rel = str(item.relative_to(vault_root))
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


def build_provenance(vault_root: Path) -> dict[str, Any]:
    """Build a provenance graph: raw sources → wiki pages."""
    wiki_dir = vault_root / "wiki"
    raw_sources: dict[str, dict] = {}
    wiki_nodes = []
    edges = []

    for md_file in wiki_dir.rglob("*.md"):
        try:
            metadata, _ = read_frontmatter(md_file)
        except Exception:
            continue

        rel = str(md_file.relative_to(vault_root))
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
                    full_src = vault_root / src_path
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

def build_graph_v2(vault_root: Path) -> dict[str, Any]:
    """Build page graph using folder-as-page model."""
    from vault_mcp.lib.pages import build_page_graph, get_page_content, FILETYPE_CATEGORIES
    graph = build_page_graph(vault_root)

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


def build_tree_v2(vault_root: Path) -> dict[str, Any]:
    """Build folder tree using the new page model."""
    from vault_mcp.lib.pages import walk_pages
    pages = walk_pages(vault_root)

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
        return {
            "id": node["id"],
            "name": Path(node["path"]).name,
            "title": node["title"],
            "type": "folder" if node["is_folder"] else "file",
            "category": node["category"],
            "children": [simplify(c) for c in node["children"]] if node["is_folder"] else [],
        }

    return {"id": "", "name": "vault", "type": "folder", "children": [simplify(r) for r in roots]}


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

@app.get("/api/graph")
def api_graph():
    return build_graph_v2(VAULT_ROOT)


@app.get("/api/provenance")
def api_provenance():
    return build_provenance(VAULT_ROOT)


@app.get("/api/registry")
def api_registry():
    return compile_tools.get_page_registry(VAULT_ROOT)


@app.get("/api/page/{path:path}")
def api_page(path: str):
    from vault_mcp.lib.pages import get_page_content, get_page_metadata
    full_path = VAULT_ROOT / path
    if not full_path.exists():
        raise HTTPException(status_code=404, detail=f"Page not found: {path}")
    content = get_page_content(full_path)
    metadata = get_page_metadata(full_path)
    return {"frontmatter": _serialize_dict(metadata), "content": content}


@app.post("/api/pages/bulk")
async def api_pages_bulk(request: Request):
    """Fetch multiple pages in a single request for faster loading."""
    from vault_mcp.lib.pages import get_page_content, get_page_metadata
    paths = await request.json()
    result = {}
    for path in paths:
        full_path = VAULT_ROOT / path
        if full_path.exists():
            content = get_page_content(full_path)
            metadata = get_page_metadata(full_path)
            result[path] = {"frontmatter": _serialize_dict(metadata), "content": content}
        else:
            result[path] = None
    return result


@app.get("/api/tree")
def api_tree():
    return build_tree_v2(VAULT_ROOT)


@app.get("/api/search")
def api_search(q: str = Query(...), scope: str = Query("all"), file_glob: str = Query("*")):
    try:
        return search_tools.ripgrep_search(VAULT_ROOT, q, scope, file_glob=file_glob)
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/health")
def api_health():
    return lint_tools.generate_health_report(VAULT_ROOT)


@app.get("/api/glossary")
def api_glossary():
    return {"content": compile_tools.get_glossary(VAULT_ROOT)}


@app.get("/api/broken-links")
def api_broken_links():
    return lint_tools.validate_links(VAULT_ROOT)


@app.get("/api/orphans")
def api_orphans():
    return lint_tools.find_orphan_pages(VAULT_ROOT)


@app.get("/api/stale")
def api_stale():
    return lint_tools.find_stale_pages(VAULT_ROOT)


# --- Layout persistence ---

LAYOUT_FILE = VAULT_ROOT / "wiki" / "meta" / "canvas-layout.json"


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

    full_path = VAULT_ROOT / path
    if not full_path.exists():
        raise HTTPException(status_code=404, detail=f"Page not found: {path}")

    from vault_mcp.lib.frontmatter import write_frontmatter
    write_frontmatter(full_path, page_frontmatter, content)
    return {"ok": True, "path": path}


# --- Chat WebSocket ---

@app.websocket("/ws/chat")
async def websocket_chat(websocket: WebSocket):
    from vault_mcp.chat import ws_chat
    await ws_chat(websocket, VAULT_ROOT)


# --- Media serving (downloaded images) ---

@app.get("/media/{filepath:path}")
def serve_media(filepath: str):
    """Serve any file from the vault (for PDFs, images, etc.)."""
    full_path = VAULT_ROOT / filepath
    if not full_path.exists():
        # Fallback to raw/media/ for backward compat
        full_path = VAULT_ROOT / "raw" / "media" / filepath
    if not full_path.exists():
        raise HTTPException(status_code=404, detail="File not found")
    return FileResponse(str(full_path))


# --- Static file serving ---

app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


@app.get("/")
def index():
    return FileResponse(str(STATIC_DIR / "index.html"))


# --- Entrypoint ---

def main():
    """Run the web UI server."""
    import uvicorn
    port = int(os.environ.get("VAULT_PORT", "8420"))
    print(f"Starting Vault UI at http://localhost:{port}")
    uvicorn.run(app, host="127.0.0.1", port=port)


if __name__ == "__main__":
    main()
