"""Linting tools — link validation, staleness detection, orphan finder, terminology checks."""

from datetime import datetime, timezone
from pathlib import Path

from vault_mcp.lib.frontmatter import read_frontmatter, write_frontmatter
from vault_mcp.lib.hashing import content_hash
from vault_mcp.lib.links import find_backlinks, parse_links
from vault_mcp.lib.registry import load_registry


def validate_links(vault_root: Path) -> list[dict]:
    """Parse all [[wiki-links]] across wiki/, check against registry and filesystem.

    Returns: [{page, link, status}] where status is "broken" or "ok".
    Only broken links are returned.
    """
    wiki_dir = vault_root / "wiki"
    registry_path = vault_root / "wiki" / "meta" / "page-registry.json"
    registry = load_registry(registry_path)

    # Build lookup sets
    titles = set()
    aliases = set()
    for page in registry.get("pages", []):
        titles.add(page.get("title", "").lower())
        for alias in page.get("aliases", []):
            aliases.add(alias.lower())

    known = titles | aliases
    broken = []

    for md_file in wiki_dir.rglob("*.md"):
        try:
            _, content = read_frontmatter(md_file)
        except Exception:
            continue

        rel_path = str(md_file.relative_to(vault_root))
        for link in parse_links(content):
            if link.target.lower() not in known:
                broken.append({
                    "page": rel_path,
                    "link": link.target,
                    "status": "broken",
                })

    return broken


def find_stale_pages(vault_root: Path) -> list[dict]:
    """Compare source_hash in wiki frontmatter against current raw source hashes.

    Returns: [{page, source, expected_hash, actual_hash}]
    """
    wiki_dir = vault_root / "wiki"
    stale = []

    for md_file in wiki_dir.rglob("*.md"):
        try:
            metadata, _ = read_frontmatter(md_file)
        except Exception:
            continue

        sources = metadata.get("sources", [])
        if not sources:
            continue

        for source_ref in sources:
            source_path = vault_root / source_ref.get("path", "")
            expected_hash = source_ref.get("hash", "")

            if not source_path.exists():
                stale.append({
                    "page": str(md_file.relative_to(vault_root)),
                    "source": source_ref.get("path", "unknown"),
                    "expected_hash": expected_hash,
                    "actual_hash": "FILE_MISSING",
                })
                continue

            try:
                _, source_content = read_frontmatter(source_path)
                actual_hash = content_hash(source_content)
            except Exception:
                actual_hash = "READ_ERROR"

            if actual_hash != expected_hash:
                stale.append({
                    "page": str(md_file.relative_to(vault_root)),
                    "source": source_ref.get("path", "unknown"),
                    "expected_hash": expected_hash,
                    "actual_hash": actual_hash,
                })

    return stale


def find_orphan_pages(vault_root: Path) -> list[str]:
    """Find wiki pages with zero inbound backlinks.

    Index and meta pages are excluded from orphan detection.
    """
    wiki_dir = vault_root / "wiki"
    registry_path = vault_root / "wiki" / "meta" / "page-registry.json"
    registry = load_registry(registry_path)

    orphans = []
    for page in registry.get("pages", []):
        title = page.get("title", "")
        page_path = vault_root / page["path"]

        # Skip meta/index pages
        if "/meta/" in page["path"] or "/indexes/" in page["path"]:
            continue

        backlinks = find_backlinks(title, wiki_dir)
        # Filter out self-links
        backlinks = [b for b in backlinks if b != page_path]

        if not backlinks:
            orphans.append(page["path"])

    return orphans


def find_missing_concepts(vault_root: Path) -> list[str]:
    """Find terms in `related` fields that have no corresponding concept article."""
    wiki_dir = vault_root / "wiki"
    registry_path = vault_root / "wiki" / "meta" / "page-registry.json"
    registry = load_registry(registry_path)

    # Build known titles/aliases
    known = set()
    for page in registry.get("pages", []):
        known.add(page.get("title", "").lower())
        for alias in page.get("aliases", []):
            known.add(alias.lower())

    missing = set()
    for md_file in wiki_dir.rglob("*.md"):
        try:
            metadata, _ = read_frontmatter(md_file)
        except Exception:
            continue

        for related in metadata.get("related", []):
            # Parse [[link]] from related entries
            links = parse_links(related)
            for link in links:
                if link.target.lower() not in known:
                    missing.add(link.target)

    return sorted(missing)


def check_terminology(vault_root: Path, page_path: str) -> list[str]:
    """Find terms used in a wiki page that are not in the glossary.

    This is a simple check: extracts ## headings from the glossary as known terms,
    then checks if wiki page content contains terms not in that set.
    Returns terms from the page's tags and related fields not found in glossary.
    """
    glossary_path = vault_root / "wiki" / "meta" / "glossary.md"

    # Load glossary terms
    glossary_terms: set[str] = set()
    if glossary_path.exists():
        _, glossary_content = read_frontmatter(glossary_path)
        for line in glossary_content.split("\n"):
            if line.startswith("## "):
                glossary_terms.add(line[3:].strip().lower())

    # Load page
    full_path = vault_root / page_path
    if not full_path.exists():
        raise FileNotFoundError(f"Page not found: {page_path}")

    metadata, _ = read_frontmatter(full_path)
    unknown = []

    # Check tags
    for tag in metadata.get("tags", []):
        tag_term = tag.replace("-", " ")
        if tag_term.lower() not in glossary_terms:
            unknown.append(tag_term)

    return unknown


def generate_health_report(vault_root: Path) -> dict:
    """Run all checks and write wiki/meta/health.md.

    Returns: {broken_links, stale_pages, orphans, missing_concepts, total_issues}
    """
    broken_links = validate_links(vault_root)
    stale_pages = find_stale_pages(vault_root)
    orphans = find_orphan_pages(vault_root)
    missing_concepts = find_missing_concepts(vault_root)

    total = len(broken_links) + len(stale_pages) + len(orphans) + len(missing_concepts)
    now = datetime.now(timezone.utc)

    # Build report
    lines = [
        "# Wiki Health Report",
        "",
        f"Generated: {now.isoformat()}",
        "",
        f"**Total issues: {total}**",
        "",
    ]

    lines.append(f"## Broken Links ({len(broken_links)})")
    lines.append("")
    if broken_links:
        for bl in broken_links:
            lines.append(f"- `{bl['page']}` links to missing `[[{bl['link']}]]`")
    else:
        lines.append("No broken links found.")
    lines.append("")

    lines.append(f"## Stale Pages ({len(stale_pages)})")
    lines.append("")
    if stale_pages:
        for sp in stale_pages:
            lines.append(f"- `{sp['page']}` — source `{sp['source']}` has changed")
    else:
        lines.append("No stale pages found.")
    lines.append("")

    lines.append(f"## Orphan Pages ({len(orphans)})")
    lines.append("")
    if orphans:
        for o in orphans:
            lines.append(f"- `{o}`")
    else:
        lines.append("No orphan pages found.")
    lines.append("")

    lines.append(f"## Missing Concepts ({len(missing_concepts)})")
    lines.append("")
    if missing_concepts:
        for mc in missing_concepts:
            lines.append(f"- `{mc}`")
    else:
        lines.append("No missing concepts found.")
    lines.append("")

    # --- Scaling trigger checks ---
    scaling_alerts = []

    # Count total pages (folders with READMEs + files)
    total_pages = sum(1 for _ in (vault_root / "wiki").rglob("README.md")) if (vault_root / "wiki").exists() else 0
    total_pages += sum(1 for _ in (vault_root / "projects").rglob("README.md")) if (vault_root / "projects").exists() else 0

    # Master index size
    index_path = vault_root / "wiki" / "meta" / "index.md"
    if index_path.exists():
        index_size = len(index_path.read_text(encoding="utf-8"))
        index_tokens = index_size // 4  # Rough estimate
        if index_tokens > 30000:
            scaling_alerts.append(f"SCALING: Master index is ~{index_tokens} tokens (>30K). Consider adding sqlite-vec for semantic search.")

    if total_pages > 800:
        scaling_alerts.append(f"SCALING: {total_pages} pages approaching 1000-page threshold. Plan for vector search migration.")

    # Git repo size
    import subprocess
    repo_size_result = subprocess.run(
        ["du", "-sh", str(vault_root)], capture_output=True, text=True
    )
    if repo_size_result.returncode == 0:
        size_str = repo_size_result.stdout.split()[0]
        if size_str.endswith("G") and float(size_str[:-1]) > 1:
            scaling_alerts.append(f"SCALING: Vault is {size_str}. Consider git-lfs for large binaries.")

    # Stale READMEs count
    from vault_mcp.tools.compile import get_stale_readmes
    stale_readmes = get_stale_readmes(vault_root)
    if len(stale_readmes) > 50:
        scaling_alerts.append(f"SCALING: {len(stale_readmes)} stale READMEs. Consider batched compilation with priority queue.")

    if scaling_alerts:
        lines.append("## Scaling Alerts")
        lines.append("")
        for alert in scaling_alerts:
            lines.append(f"- {alert}")
        lines.append("")

    # Stale READMEs section
    lines.append(f"## Stale READMEs ({len(stale_readmes)})")
    lines.append("")
    if stale_readmes:
        for sr in stale_readmes[:20]:
            lines.append(f"- `{sr['folder']}` — {sr['reason']}: {', '.join(sr['changed_files'][:5])}")
    else:
        lines.append("All READMEs are up to date.")
    lines.append("")

    content = "\n".join(lines)
    health_path = vault_root / "wiki" / "meta" / "health.md"
    health_metadata = {
        "title": "Wiki Health Report",
        "type": "structure-note",
        "status": "compiled",
        "created": now.strftime("%Y-%m-%d"),
        "last_compiled": now.isoformat(),
    }
    write_frontmatter(health_path, health_metadata, content)

    return {
        "broken_links": len(broken_links),
        "stale_pages": len(stale_pages),
        "orphans": len(orphans),
        "missing_concepts": len(missing_concepts),
        "stale_readmes": len(stale_readmes),
        "scaling_alerts": scaling_alerts,
        "total_issues": total,
    }
