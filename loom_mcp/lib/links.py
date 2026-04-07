"""[[wiki-link]] parsing and resolution utilities."""

import re
from pathlib import Path
from typing import NamedTuple


class WikiLink(NamedTuple):
    """A parsed wiki-style link."""
    target: str       # The page name being linked to
    display: str      # The display text (same as target if no alias)
    raw: str          # The original raw link text including brackets


# Matches [[Target]] or [[Target|Display Text]]
_WIKI_LINK_PATTERN = re.compile(r"\[\[([^\]|]+?)(?:\|([^\]]+?))?\]\]")


def parse_links(text: str) -> list[WikiLink]:
    """Extract all [[wiki-links]] from markdown text.

    Supports both [[Target]] and [[Target|Display Text]] syntax.
    """
    links = []
    for match in _WIKI_LINK_PATTERN.finditer(text):
        target = match.group(1).strip()
        display = (match.group(2) or target).strip()
        links.append(WikiLink(target=target, display=display, raw=match.group(0)))
    return links


def resolve_link(
    target: str,
    registry: dict,
    wiki_dir: Path,
) -> Path | None:
    """Resolve a wiki link target to a file path.

    Checks the page registry first (by title and aliases), then falls back
    to filesystem search. Returns None if unresolvable.
    """
    target_lower = target.lower()

    for page in registry.get("pages", []):
        if page.get("title", "").lower() == target_lower:
            return wiki_dir / page["path"]
        for alias in page.get("aliases", []):
            if alias.lower() == target_lower:
                return wiki_dir / page["path"]

    return None


def find_backlinks(target_title: str, wiki_dir: Path) -> list[Path]:
    """Find all wiki pages that link to the given target title."""
    backlinks = []
    target_lower = target_title.lower()

    for md_file in wiki_dir.rglob("*.md"):
        try:
            text = md_file.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        for link in parse_links(text):
            if link.target.lower() == target_lower:
                backlinks.append(md_file)
                break

    return backlinks
