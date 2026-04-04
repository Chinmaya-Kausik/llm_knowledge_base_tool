"""Tests for git tools."""

import subprocess
import tempfile
from pathlib import Path

from vault_mcp.lib.frontmatter import write_frontmatter
from vault_mcp.tools.git import auto_commit, get_recent_changes


def _make_git_vault(tmp: str) -> Path:
    root = Path(tmp) / "vault"
    (root / "wiki" / "concepts").mkdir(parents=True)
    (root / "wiki" / "meta").mkdir(parents=True)
    subprocess.run(["git", "init"], cwd=str(root), capture_output=True)
    subprocess.run(["git", "config", "user.email", "test@test.com"], cwd=str(root), capture_output=True)
    subprocess.run(["git", "config", "user.name", "Test"], cwd=str(root), capture_output=True)
    # Initial commit
    (root / ".gitkeep").write_text("")
    subprocess.run(["git", "add", "."], cwd=str(root), capture_output=True)
    subprocess.run(["git", "commit", "-m", "init"], cwd=str(root), capture_output=True)
    return root


def test_auto_commit_no_changes():
    with tempfile.TemporaryDirectory() as tmp:
        vault = _make_git_vault(tmp)
        result = auto_commit(vault, "No changes")
        assert result["committed"] is False


def test_auto_commit_with_changes():
    with tempfile.TemporaryDirectory() as tmp:
        vault = _make_git_vault(tmp)
        write_frontmatter(
            vault / "wiki" / "concepts" / "test.md",
            {"title": "Test"},
            "Content.",
        )
        result = auto_commit(vault, "Add test page")
        assert result["committed"] is True
        assert result["hash"]
        assert result["message"] == "Add test page"


def test_auto_commit_only_stages_wiki():
    with tempfile.TemporaryDirectory() as tmp:
        vault = _make_git_vault(tmp)
        # Create file outside wiki/
        (vault / "other.txt").write_text("Not wiki.")
        write_frontmatter(vault / "wiki" / "concepts" / "a.md", {"title": "A"}, "Wiki content.")

        auto_commit(vault, "Wiki only")

        # Check that other.txt is not committed
        status = subprocess.run(
            ["git", "status", "--porcelain"],
            cwd=str(vault), capture_output=True, text=True,
        )
        assert "other.txt" in status.stdout  # Still untracked


def test_get_recent_changes():
    with tempfile.TemporaryDirectory() as tmp:
        vault = _make_git_vault(tmp)
        changes = get_recent_changes(vault, n=5)
        assert len(changes) == 1
        assert changes[0]["message"] == "init"


def test_get_recent_changes_after_commit():
    with tempfile.TemporaryDirectory() as tmp:
        vault = _make_git_vault(tmp)
        write_frontmatter(vault / "wiki" / "concepts" / "a.md", {"title": "A"}, "Content.")
        auto_commit(vault, "Add A")

        changes = get_recent_changes(vault, n=5)
        assert len(changes) == 2
        assert changes[0]["message"] == "Add A"
