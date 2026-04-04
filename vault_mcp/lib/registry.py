"""page-registry.json management utilities."""

import json
from pathlib import Path
from typing import Any


def load_registry(registry_path: Path) -> dict[str, Any]:
    """Load the page registry from disk.

    Returns {"pages": []} if file doesn't exist or is invalid.
    """
    if not registry_path.exists():
        return {"pages": []}
    try:
        data = json.loads(registry_path.read_text(encoding="utf-8"))
        if "pages" not in data:
            data["pages"] = []
        return data
    except (json.JSONDecodeError, OSError):
        return {"pages": []}


def save_registry(registry_path: Path, registry: dict[str, Any]) -> None:
    """Write the page registry to disk."""
    registry_path.parent.mkdir(parents=True, exist_ok=True)
    registry_path.write_text(
        json.dumps(registry, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )


def add_page(
    registry: dict[str, Any],
    title: str,
    path: str,
    aliases: list[str] | None = None,
) -> dict[str, Any]:
    """Add a page to the registry, or update it if a page with the same path exists.

    Returns the updated registry.
    """
    aliases = aliases or []

    for page in registry["pages"]:
        if page["path"] == path:
            page["title"] = title
            page["aliases"] = aliases
            return registry

    registry["pages"].append({
        "title": title,
        "path": path,
        "aliases": aliases,
    })
    return registry


def remove_page(registry: dict[str, Any], path: str) -> dict[str, Any]:
    """Remove a page from the registry by path.

    Returns the updated registry.
    """
    registry["pages"] = [p for p in registry["pages"] if p["path"] != path]
    return registry


def find_page(registry: dict[str, Any], title: str) -> dict[str, Any] | None:
    """Find a page in the registry by title or alias.

    Returns the page dict or None.
    """
    title_lower = title.lower()
    for page in registry["pages"]:
        if page.get("title", "").lower() == title_lower:
            return page
        for alias in page.get("aliases", []):
            if alias.lower() == title_lower:
                return page
    return None
