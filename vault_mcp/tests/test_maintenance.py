"""Tests for maintenance tools — change detection, stale READMEs, chat transcripts."""

import subprocess
import tempfile
import time
from pathlib import Path

from vault_mcp.lib.frontmatter import write_frontmatter
from vault_mcp.tools.compile import detect_changes, get_stale_readmes, save_chat_transcript


def _make_git_vault(tmp: str) -> Path:
    root = Path(tmp) / "vault"
    root.mkdir()
    subprocess.run(["git", "init"], cwd=str(root), capture_output=True)
    subprocess.run(["git", "config", "user.email", "test@test.com"], cwd=str(root), capture_output=True)
    subprocess.run(["git", "config", "user.name", "Test"], cwd=str(root), capture_output=True)

    # Create initial structure
    (root / "wiki").mkdir()
    write_frontmatter(root / "wiki" / "README.md", {"title": "Wiki"}, "# Wiki\n")
    (root / "projects").mkdir()

    subprocess.run(["git", "add", "."], cwd=str(root), capture_output=True)
    subprocess.run(["git", "commit", "-m", "init"], cwd=str(root), capture_output=True)
    return root


# --- detect_changes ---

def test_detect_changes_empty():
    with tempfile.TemporaryDirectory() as tmp:
        vault = _make_git_vault(tmp)
        changes = detect_changes(vault)
        assert changes == []


def test_detect_changes_modified():
    with tempfile.TemporaryDirectory() as tmp:
        vault = _make_git_vault(tmp)
        (vault / "wiki" / "README.md").write_text("# Updated\n")
        subprocess.run(["git", "add", "."], cwd=str(vault), capture_output=True)
        subprocess.run(["git", "commit", "-m", "update"], cwd=str(vault), capture_output=True)

        changes = detect_changes(vault, "HEAD~1")
        paths = {c["path"] for c in changes}
        assert "wiki/README.md" in paths


def test_detect_changes_added():
    with tempfile.TemporaryDirectory() as tmp:
        vault = _make_git_vault(tmp)
        (vault / "wiki" / "new.md").write_text("# New\n")
        subprocess.run(["git", "add", "."], cwd=str(vault), capture_output=True)
        subprocess.run(["git", "commit", "-m", "add"], cwd=str(vault), capture_output=True)

        changes = detect_changes(vault, "HEAD~1")
        statuses = {c["path"]: c["status"] for c in changes}
        assert statuses.get("wiki/new.md") == "added"


# --- get_stale_readmes ---

def test_stale_readme_missing():
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp) / "vault"
        root.mkdir()
        proj = root / "projects" / "my-app"
        proj.mkdir(parents=True)
        (proj / "main.py").write_text("print('hello')")
        # No README.md in my-app — should be flagged

        stale = get_stale_readmes(root)
        folders = {s["folder"] for s in stale}
        assert "projects/my-app" in folders
        assert any(s["reason"] == "missing" for s in stale if s["folder"] == "projects/my-app")


def test_stale_readme_outdated():
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp) / "vault"
        root.mkdir()
        proj = root / "projects" / "my-app"
        proj.mkdir(parents=True)
        write_frontmatter(proj / "README.md", {"title": "My App"}, "# My App\n")
        time.sleep(0.1)  # Ensure different mtime
        (proj / "main.py").write_text("print('hello')")

        stale = get_stale_readmes(root)
        outdated = [s for s in stale if s["folder"] == "projects/my-app" and s["reason"] == "outdated"]
        assert len(outdated) == 1
        assert "main.py" in outdated[0]["changed_files"]


def test_stale_readme_fresh():
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp) / "vault"
        root.mkdir()
        proj = root / "projects" / "my-app"
        proj.mkdir(parents=True)
        (proj / "main.py").write_text("print('hello')")
        time.sleep(0.1)
        write_frontmatter(proj / "README.md", {"title": "My App"}, "# My App\n")

        stale = get_stale_readmes(root)
        folders = {s["folder"] for s in stale}
        assert "projects/my-app" not in folders


# --- save_chat_transcript ---

def test_save_chat_transcript():
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp) / "vault"
        root.mkdir()

        messages = [
            {"role": "user", "content": "What is attention?"},
            {"role": "assistant", "content": "Attention is a mechanism..."},
        ]

        result = save_chat_transcript(root, "test-session-123", messages)
        assert result["message_count"] == 2
        assert result["path"].startswith("raw/chats/")

        # Verify file exists and has content
        full_path = root / result["path"]
        assert full_path.exists()
        content = full_path.read_text()
        assert "What is attention?" in content
        assert "Attention is a mechanism" in content
        assert "test-session-123" in content


def test_save_chat_creates_dir():
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp) / "vault"
        root.mkdir()
        # raw/chats/ doesn't exist yet

        result = save_chat_transcript(root, "abc", [{"role": "user", "content": "Hi"}])
        assert (root / result["path"]).exists()
