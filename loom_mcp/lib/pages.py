"""Page abstraction — folders-as-pages with filesystem walk.

A 'page' is a folder with a README.md, or a standalone file.
Every folder and file in the loom is a page. Folder READMEs
hold LLM-maintained summaries. Files are subpages of their parent folder.
"""

import re
from pathlib import Path
from typing import Any

from loom_mcp.lib.frontmatter import read_frontmatter

# Directories and patterns to hide by default
HIDDEN_PATTERNS = {
    "__pycache__", ".git", ".venv", "venv", "node_modules",
    ".pytest_cache", ".eggs", "dist", "build", ".idea", ".vscode",
    ".DS_Store", "Thumbs.db", ".claude",
}

HIDDEN_EXTENSIONS = {".pyc", ".pyo", ".egg-info", ".swp", ".swo"}

# Filetype categories for filtering
FILETYPE_CATEGORIES = {
    "markdown": {".md"},
    "code": {".py", ".js", ".ts", ".jsx", ".tsx", ".rs", ".go", ".java", ".c", ".cpp", ".h", ".rb", ".sh", ".zsh", ".bash"},
    "papers": {".tex", ".bib", ".pdf"},
    "data": {".csv", ".json", ".yaml", ".yml", ".toml", ".xml", ".sql"},
}


def is_hidden(path: Path) -> bool:
    """Check if a path should be hidden by default."""
    name = path.name
    if name.startswith("."):
        return True
    if name in HIDDEN_PATTERNS:
        return True
    if path.suffix in HIDDEN_EXTENSIONS:
        return True
    return False


def get_filetype_category(path: Path) -> str:
    """Get the filetype category for a file."""
    ext = path.suffix.lower()
    for category, extensions in FILETYPE_CATEGORIES.items():
        if ext in extensions:
            return category
    return "misc"


def get_page_title(path: Path, loom_root: Path) -> str:
    """Get the display title for a page (folder or file).

    Uses the folder/file name directly. This is what wiki-links resolve against.
    """
    return path.name


def get_page_content(path: Path) -> str:
    """Get the content for a page.

    For folders: returns README.md content.
    For files: returns file content (for text files) or empty string.
    """
    if path.is_dir():
        readme = path / "README.md"
        if readme.exists():
            try:
                _, content = read_frontmatter(readme)
                return content
            except Exception:
                try:
                    return readme.read_text(encoding="utf-8")
                except Exception:
                    return ""
        return ""
    else:
        try:
            # For markdown files: parse frontmatter and return content body only
            if path.suffix == ".md":
                try:
                    _, content = read_frontmatter(path)
                    return content
                except Exception:
                    pass
            return path.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            return ""


def get_page_metadata(path: Path) -> dict[str, Any]:
    """Get metadata for a page.

    For folders: reads frontmatter from README.md.
    For files: reads frontmatter (if markdown) or returns basic metadata.
    """
    meta: dict[str, Any] = {}
    if path.is_dir():
        readme = path / "README.md"
        if readme.exists():
            try:
                meta, _ = read_frontmatter(readme)
            except Exception:
                pass
    elif path.suffix == ".md":
        try:
            meta, _ = read_frontmatter(path)
        except Exception:
            pass
    return meta


def walk_pages(loom_root: Path, include_hidden: bool = False) -> list[dict[str, Any]]:
    """Walk the loom and return all pages (folders + files).

    Returns a flat list of page descriptors:
    [{id, title, path, is_folder, parent_id, children_ids, type, category, metadata}]
    """
    pages: list[dict[str, Any]] = []
    page_ids: set[str] = set()

    def _walk(directory: Path, parent_id: str | None):
        if not directory.exists() or not directory.is_dir():
            return

        try:
            items = sorted(directory.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower()))
        except (PermissionError, OSError):
            return

        for item in items:
            if not include_hidden and is_hidden(item):
                continue
            if item.is_symlink():
                continue

            # Skip README.md and MEMORY.md — represented by parent folder / memory system
            if item.name in ("README.md", "MEMORY.md") and item.is_file():
                continue

            rel = str(item.relative_to(loom_root))

            # Skip the meta directory internals from canvas (but not from tree)
            if rel.startswith("wiki/meta/") and item.is_file():
                continue

            title = get_page_title(item, loom_root)
            meta = get_page_metadata(item)

            page = {
                "id": rel,
                "title": title,
                "path": rel,
                "is_folder": item.is_dir(),
                "parent_id": parent_id,
                "children_ids": [],
                "type": meta.get("type", "folder" if item.is_dir() else get_filetype_category(item)),
                "category": "folder" if item.is_dir() else get_filetype_category(item),
                "status": meta.get("status", ""),
                "tags": meta.get("tags", []),
                "confidence": meta.get("confidence", ""),
                "has_readme": (item / "README.md").exists() if item.is_dir() else False,
            }

            pages.append(page)
            page_ids.add(rel)

            # Add as child of parent
            if parent_id is not None:
                for p in pages:
                    if p["id"] == parent_id:
                        p["children_ids"].append(rel)
                        break

            # Recurse into directories
            if item.is_dir():
                _walk(item, rel)

    _walk(loom_root, None)
    return pages


def resolve_wiki_link(target: str, pages: list[dict]) -> str | None:
    """Resolve a [[wiki-link]] target to a page ID.

    Matches against:
    1. Full or partial path (e.g., [[wiki/attention]] or [[projects/data-pipeline]])
    2. Folder/file name (e.g., [[attention]]) — first match wins
    All case-insensitive.
    """
    target_lower = target.lower()
    # Try path match first (most specific)
    for page in pages:
        if page["id"].lower() == target_lower or page["path"].lower() == target_lower:
            return page["id"]
        # Partial path suffix match (e.g., "wiki/attention" matches "wiki/attention")
        if page["id"].lower().endswith("/" + target_lower) or page["id"].lower() == target_lower:
            return page["id"]
    # Fall back to name/stem match
    for page in pages:
        name = Path(page["path"]).name.lower()
        stem = Path(page["path"]).stem.lower()
        if name == target_lower or stem == target_lower:
            return page["id"]
    return None


def build_page_graph(loom_root: Path, include_hidden: bool = False) -> dict[str, Any]:
    """Build the full page graph for the loom.

    Returns:
    {
        pages: [...],          # All pages
        edges: [...],          # All edges from [[wiki-links]]
        top_pages: [...],      # Top-level pages (children of loom root)
        top_edges: [...],      # Edges aggregated to top-level
    }
    """
    from loom_mcp.lib.links import parse_links

    pages = walk_pages(loom_root, include_hidden)
    page_map = {p["id"]: p for p in pages}

    # Build edges from [[wiki-links]] in page content
    edges = []
    edge_set: set[tuple[str, str]] = set()

    for page in pages:
        full_path = loom_root / page["path"]
        content = get_page_content(full_path)
        if not content:
            continue

        links = parse_links(content)

        # Also parse links from metadata 'related' field
        meta = page.get("_meta", {}) or get_page_metadata(full_path)
        for related in meta.get("related", []):
            links.extend(parse_links(related))

        for link in links:
            target_id = resolve_wiki_link(link.target, pages)
            if target_id and target_id != page["id"]:
                key = (page["id"], target_id)
                if key not in edge_set:
                    edge_set.add(key)
                    edges.append({"source": page["id"], "target": target_id, "label": link.target})

    # Top-level pages: direct children of loom root
    top_pages = [p for p in pages if p["parent_id"] is None]

    # Aggregate edges to top-level
    def get_top_ancestor(page_id: str) -> str:
        visited = set()
        current = page_id
        while current in page_map and page_map[current].get("parent_id") and current not in visited:
            visited.add(current)
            current = page_map[current]["parent_id"]
        return current

    top_edge_set: set[tuple[str, str]] = set()
    top_edges = []
    for edge in edges:
        src_top = get_top_ancestor(edge["source"])
        tgt_top = get_top_ancestor(edge["target"])
        if src_top == tgt_top:
            continue
        key = (src_top, tgt_top)
        if key not in top_edge_set:
            top_edge_set.add(key)
            top_edges.append({"source": src_top, "target": tgt_top})

    return {
        "pages": pages,
        "edges": edges,
        "top_pages": top_pages,
        "top_edges": top_edges,
    }
