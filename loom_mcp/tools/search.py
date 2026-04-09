"""Search tools — ripgrep wrapper, index reader, and index writer."""

import re
import subprocess
from datetime import datetime, timezone
from pathlib import Path

from loom_mcp.lib.frontmatter import read_frontmatter, write_frontmatter


def ripgrep_search(
    loom_root: Path,
    query: str,
    scope: str = "all",
    context_lines: int = 3,
    file_glob: str = "*",
) -> list[dict]:
    """Search file contents using ripgrep.

    Args:
        query: Search pattern (supports regex).
        scope: "raw", "wiki", "projects", or "all".
        context_lines: Number of context lines around matches.
        file_glob: File pattern to search (e.g., "*.py", "*.md", "*" for all).

    Returns: [{path, line, context}]
    """
    scope_map = {
        "raw": loom_root / "raw",
        "wiki": loom_root / "wiki",
        "projects": loom_root / "projects",
        "all": loom_root,
    }
    if scope in scope_map:
        search_path = scope_map[scope]
    else:
        # Treat scope as a relative path within the loom
        candidate = (loom_root / scope).resolve()
        if str(candidate).startswith(str(loom_root.resolve())) and candidate.exists():
            search_path = candidate
        else:
            search_path = loom_root

    # Find ripgrep — check common locations including Claude Code's vendored copy
    import shutil
    rg_path = shutil.which("rg")
    if not rg_path:
        # Check Claude Code's vendored ripgrep
        import platform
        arch = "arm64" if platform.machine() == "arm64" else "x64"
        system = "darwin" if platform.system() == "Darwin" else "linux"
        vendored = Path.home() / ".npm-global/lib/node_modules/@anthropic-ai/claude-code/vendor/ripgrep" / f"{arch}-{system}" / "rg"
        if vendored.exists():
            rg_path = str(vendored)
        else:
            raise RuntimeError("ripgrep (rg) is not installed. Install it with: brew install ripgrep")

    cmd = [
        rg_path,
        "--json",
        "-C", str(context_lines),
        "--glob", file_glob,
        query,
        str(search_path),
    ]

    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
    except FileNotFoundError:
        raise RuntimeError("ripgrep (rg) is not installed. Install it with: brew install ripgrep")
    except subprocess.TimeoutExpired:
        return [{"path": "", "line": 0, "context": "Search timed out"}]

    import json
    matches = []
    for line in result.stdout.strip().split("\n"):
        if not line:
            continue
        try:
            data = json.loads(line)
        except json.JSONDecodeError:
            continue
        if data.get("type") == "match":
            match_data = data["data"]
            file_path = match_data["path"]["text"]
            try:
                rel_path = str(Path(file_path).relative_to(loom_root))
            except ValueError:
                rel_path = file_path
            matches.append({
                "path": rel_path,
                "line": match_data["line_number"],
                "context": match_data["lines"]["text"].rstrip(),
            })

    return matches


def filename_search(loom_root: Path, query: str, scope: str = "all") -> list[dict]:
    """Search for files by name using glob-style matching.

    Returns: [{path, line: 0, context: filename}]
    """
    import re
    scope_map = {
        "raw": loom_root / "raw",
        "wiki": loom_root / "wiki",
        "projects": loom_root / "projects",
        "all": loom_root,
    }
    if scope in scope_map:
        search_path = scope_map[scope]
    else:
        candidate = (loom_root / scope).resolve()
        if str(candidate).startswith(str(loom_root.resolve())) and candidate.exists():
            search_path = candidate
        else:
            search_path = loom_root

    pattern = re.compile(re.escape(query), re.IGNORECASE)
    matches = []
    for p in search_path.rglob("*"):
        if pattern.search(p.name):
            try:
                rel = str(p.relative_to(loom_root))
            except ValueError:
                rel = str(p)
            matches.append({"path": rel, "line": 0, "context": p.name})
            if len(matches) >= 50:
                break
    return matches


def read_index(loom_root: Path, topic: str) -> str:
    """Read a topic index file from wiki/meta/indexes/.

    Args:
        topic: The topic name (used to find the index file).

    Returns: The index file content, or an error message if not found.
    """
    indexes_dir = loom_root / "wiki" / "meta" / "indexes"
    if not indexes_dir.exists():
        return f"No indexes directory found."

    # Try exact match first, then slug match
    for md_file in indexes_dir.glob("*.md"):
        if md_file.stem.lower() == topic.lower():
            _, content = read_frontmatter(md_file)
            return content
        if md_file.stem.lower().replace("-", " ") == topic.lower():
            _, content = read_frontmatter(md_file)
            return content

    # List available indexes
    available = [f.stem for f in indexes_dir.glob("*.md")]
    if available:
        return f"Index '{topic}' not found. Available indexes: {', '.join(available)}"
    return f"Index '{topic}' not found. No indexes exist yet."


def write_index(loom_root: Path, topic: str, content: str) -> dict:
    """Write or update a topic index file at wiki/meta/indexes/{topic}.md.

    The LLM uses this to maintain index files with brief summaries of all
    pages in a topic cluster — the key to making Q&A work without RAG.

    Args:
        topic: Topic name (used for filename and title).
        content: Markdown content for the index (the LLM writes this).

    Returns: {path, topic, created}
    """
    indexes_dir = loom_root / "wiki" / "meta" / "indexes"
    indexes_dir.mkdir(parents=True, exist_ok=True)

    slug = re.sub(r"[^\w\s-]", "", topic.lower())
    slug = re.sub(r"[\s]+", "-", slug).strip("-")
    path = indexes_dir / f"{slug}.md"
    is_new = not path.exists()

    now = datetime.now(timezone.utc)
    metadata = {
        "title": f"{topic} — Index",
        "type": "index",
        "status": "compiled",
        "created": now.strftime("%Y-%m-%d") if is_new else None,
        "last_compiled": now.isoformat(),
    }

    # Preserve created date if updating
    if not is_new:
        try:
            old_meta, _ = read_frontmatter(path)
            metadata["created"] = old_meta.get("created", now.strftime("%Y-%m-%d"))
        except Exception:
            metadata["created"] = now.strftime("%Y-%m-%d")
    else:
        metadata["created"] = now.strftime("%Y-%m-%d")

    write_frontmatter(path, metadata, content)

    rel_path = str(path.relative_to(loom_root))
    return {"path": rel_path, "topic": topic, "created": is_new}


def search_by_tags(
    loom_root: Path,
    tags: list[str],
    scope: str = "all",
    match_all: bool = False,
) -> list[dict]:
    """Find pages and memories by frontmatter tags.

    Args:
        tags: Tags to search for.
        scope: "wiki", "memory", "projects", or "all".
        match_all: If True, page must have ALL tags. If False, any tag matches.

    Returns: [{path, title, type, tags, summary}]
    """
    scope_dirs = {
        "wiki": [loom_root / "wiki"],
        "memory": [loom_root / "wiki" / "meta" / "memory"],
        "projects": [loom_root / "projects"],
        "all": [loom_root / "wiki", loom_root / "projects", loom_root / "raw"],
    }
    dirs = scope_dirs.get(scope, scope_dirs["all"])
    tags_lower = {t.lower() for t in tags}
    results = []

    for search_dir in dirs:
        if not search_dir.exists():
            continue
        for md_file in search_dir.rglob("*.md"):
            try:
                meta, content = read_frontmatter(md_file)
            except Exception:
                continue

            page_tags = meta.get("tags", [])
            if not page_tags:
                continue
            page_tags_lower = {t.lower() for t in page_tags}

            if match_all:
                if not tags_lower.issubset(page_tags_lower):
                    continue
            else:
                if not tags_lower & page_tags_lower:
                    continue

            # Extract first non-heading line as summary
            summary = ""
            for line in content.split("\n"):
                line = line.strip()
                if line and not line.startswith("#") and not line.startswith("---"):
                    summary = line[:150]
                    break

            results.append({
                "path": str(md_file.relative_to(loom_root)),
                "title": meta.get("title", md_file.stem),
                "type": meta.get("type", "unknown"),
                "tags": page_tags,
                "summary": summary,
            })

    return results
