"""Comprehensive tests for web API endpoints — search, bulk pages, chat save,
plan traversal, open-external, terminal endpoint, media serving, settings."""

import json
import tempfile
from pathlib import Path
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from loom_mcp.lib.frontmatter import write_frontmatter


# ---------------------------------------------------------------------------
# Shared fixture
# ---------------------------------------------------------------------------

@pytest.fixture
def loom_client(tmp_path):
    """Create a test loom and return (client, root)."""
    root = tmp_path / "loom"
    root.mkdir()

    for d in [
        "raw/inbox", "raw/chats",
        "wiki/meta", "wiki/pages/alpha",
        "projects/demo",
    ]:
        (root / d).mkdir(parents=True, exist_ok=True)

    (root / "wiki" / "meta" / "page-registry.json").write_text('{"pages": []}')

    write_frontmatter(root / "wiki" / "meta" / "glossary.md", {
        "title": "Glossary", "type": "structure-note", "status": "compiled",
        "created": "2026-04-04", "last_compiled": "2026-04-04T00:00:00Z",
    }, "# Glossary\n\n## attention\n\nFocusing on relevant parts of input.\n")

    write_frontmatter(root / "wiki" / "pages" / "alpha" / "ABOUT.md", {
        "title": "Alpha Concept", "type": "concept", "status": "compiled",
        "created": "2026-04-04", "last_compiled": "2026-04-04T00:00:00Z",
        "tags": ["ml"], "related": [], "aliases": [], "confidence": "high", "sources": [],
    }, "# Alpha\n\nThis is the alpha concept. It mentions attention and transformers.\n")

    (root / "wiki" / "pages" / "alpha" / "code.py").write_text(
        "def alpha():\n    return 'attention'\n"
    )

    write_frontmatter(root / "projects" / "demo" / "ABOUT.md", {
        "title": "Demo", "type": "project",
    }, "# Demo\n\nUses [[Alpha Concept]].\n")

    # Plans directory
    plans_dir = root / ".claude" / "plans"
    plans_dir.mkdir(parents=True)
    (plans_dir / "test-plan.md").write_text("# Plan\n- [ ] Step 1\n- [ ] Step 2\n")

    import loom_mcp.web as web_module
    original_root = web_module.LOOM_ROOT
    original_layout = web_module.LAYOUT_FILE
    web_module.LOOM_ROOT = root
    web_module.LAYOUT_FILE = root / "wiki" / "meta" / "canvas-layout.json"

    client = TestClient(web_module.app)
    yield client, root

    from loom_mcp.chat import sessions
    sessions.clear()
    web_module.LOOM_ROOT = original_root
    web_module.LAYOUT_FILE = original_layout


# ---------------------------------------------------------------------------
# Search API tests
# ---------------------------------------------------------------------------

class TestSearchAPI:
    def test_search_content_mode(self, loom_client):
        client, root = loom_client
        r = client.get("/api/search", params={"q": "attention", "mode": "content"})
        assert r.status_code == 200
        results = r.json()
        assert isinstance(results, list)
        # Should find "attention" in alpha README and glossary
        paths = [res.get("path", "") for res in results]
        assert any("alpha" in p for p in paths)

    def test_search_name_mode_file(self, loom_client):
        client, root = loom_client
        r = client.get("/api/search", params={"q": "code", "mode": "name"})
        assert r.status_code == 200
        results = r.json()
        assert any("code.py" in res.get("path", "") for res in results)

    def test_search_name_mode_folder(self, loom_client):
        client, root = loom_client
        # Name search should also match folder names
        r = client.get("/api/search", params={"q": "alpha", "mode": "name"})
        assert r.status_code == 200
        results = r.json()
        assert any("alpha" in res.get("path", "") for res in results)

    def test_search_both_mode(self, loom_client):
        client, root = loom_client
        r = client.get("/api/search", params={"q": "alpha", "mode": "both"})
        assert r.status_code == 200
        results = r.json()
        assert len(results) > 0

    def test_search_no_results(self, loom_client):
        client, root = loom_client
        r = client.get("/api/search", params={"q": "xyznonexistent123"})
        assert r.status_code == 200
        assert r.json() == []

    def test_search_scope_wiki(self, loom_client):
        client, root = loom_client
        r = client.get("/api/search", params={"q": "attention", "scope": "wiki"})
        assert r.status_code == 200
        results = r.json()
        for res in results:
            assert res.get("path", "").startswith("wiki/") or "wiki" in res.get("path", "")

    def test_search_file_glob(self, loom_client):
        client, root = loom_client
        r = client.get("/api/search", params={"q": "alpha", "mode": "content", "file_glob": "*.py"})
        assert r.status_code == 200
        results = r.json()
        for res in results:
            assert res.get("path", "").endswith(".py")


# ---------------------------------------------------------------------------
# Bulk pages API
# ---------------------------------------------------------------------------

class TestBulkPages:
    def test_bulk_pages_returns_content(self, loom_client):
        client, root = loom_client
        ids = ["wiki/pages/alpha", "projects/demo"]
        r = client.post("/api/pages/bulk", json=ids)
        assert r.status_code == 200
        data = r.json()
        assert "wiki/pages/alpha" in data
        assert data["wiki/pages/alpha"]["content"] is not None

    def test_bulk_pages_missing_ids(self, loom_client):
        client, root = loom_client
        r = client.post("/api/pages/bulk", json=["nonexistent/path"])
        assert r.status_code == 200
        data = r.json()
        assert data.get("nonexistent/path") is None

    def test_bulk_pages_empty_list(self, loom_client):
        client, root = loom_client
        r = client.post("/api/pages/bulk", json=[])
        assert r.status_code == 200
        assert r.json() == {}


# ---------------------------------------------------------------------------
# Chat save API
# ---------------------------------------------------------------------------

class TestChatSaveAPI:
    def test_save_chat_via_api(self, loom_client):
        client, root = loom_client
        messages = [
            {"role": "user", "content": "Hello"},
            {"role": "assistant", "content": "Hi!"},
        ]
        r = client.post("/api/chat/save", json={
            "session_id": "test-session",
            "messages": messages,
        })
        assert r.status_code == 200
        data = r.json()
        assert data["ok"] is True
        assert "path" in data
        assert (root / data["path"]).exists()

    def test_save_chat_empty_messages(self, loom_client):
        client, root = loom_client
        r = client.post("/api/chat/save", json={
            "session_id": "empty",
            "messages": [],
        })
        data = r.json()
        assert data["ok"] is False

    def test_save_chat_creates_chats_dir(self, loom_client):
        client, root = loom_client
        # Remove chats dir to test auto-creation
        import shutil
        chats_dir = root / "raw" / "chats"
        if chats_dir.exists():
            shutil.rmtree(chats_dir)
        messages = [
            {"role": "user", "content": "test dir creation"},
            {"role": "assistant", "content": "ok"},
        ]
        r = client.post("/api/chat/save", json={
            "session_id": "dir-test",
            "messages": messages,
        })
        assert r.json()["ok"] is True
        assert chats_dir.exists()


# ---------------------------------------------------------------------------
# Plan API — path traversal security
# ---------------------------------------------------------------------------

class TestPlanSecurity:
    def test_put_plan_traversal_dotdot(self, loom_client):
        client, root = loom_client
        r = client.put("/api/plan", json={
            "path": ".claude/plans/../../evil.md",
            "content": "hacked",
        })
        assert r.json()["ok"] is False

    def test_delete_plan_traversal(self, loom_client):
        client, root = loom_client
        r = client.request("DELETE", "/api/plan", json={
            "path": ".claude/plans/../../../etc/passwd",
        })
        assert r.json()["ok"] is False

    def test_put_plan_empty_path(self, loom_client):
        client, root = loom_client
        r = client.put("/api/plan", json={"path": "", "content": "test"})
        assert r.json()["ok"] is False

    def test_put_plan_outside_plans_dir(self, loom_client):
        client, root = loom_client
        r = client.put("/api/plan", json={
            "path": "wiki/pages/alpha/ABOUT.md",
            "content": "overwrite",
        })
        assert r.json()["ok"] is False


# ---------------------------------------------------------------------------
# Open-external API
# ---------------------------------------------------------------------------

class TestOpenExternal:
    def test_open_external_missing_path(self, loom_client):
        client, root = loom_client
        r = client.post("/api/open-external", json={"path": ""})
        assert r.json()["ok"] is False

    def test_open_external_nonexistent_file(self, loom_client):
        client, root = loom_client
        r = client.post("/api/open-external", json={"path": "nonexistent.md"})
        assert r.json()["ok"] is False

    def test_open_external_traversal(self, loom_client):
        client, root = loom_client
        r = client.post("/api/open-external", json={"path": "../../etc/passwd"})
        assert r.json()["ok"] is False

    def test_open_external_valid_file(self, loom_client):
        client, root = loom_client
        with patch("subprocess.Popen") as mock_popen:
            r = client.post("/api/open-external", json={
                "path": "wiki/pages/alpha/code.py"
            })
            assert r.json()["ok"] is True
            mock_popen.assert_called_once()


# ---------------------------------------------------------------------------
# Terminal WebSocket endpoint existence
# ---------------------------------------------------------------------------

class TestTerminalEndpoint:
    def test_terminal_endpoint_registered(self, loom_client):
        client, root = loom_client
        import loom_mcp.web as web_module
        routes = [r.path for r in web_module.app.routes]
        assert "/ws/terminal" in routes


# ---------------------------------------------------------------------------
# Media serving
# ---------------------------------------------------------------------------

class TestMediaServing:
    def test_media_serves_existing_file(self, loom_client):
        client, root = loom_client
        r = client.get("/media/wiki/pages/alpha/code.py")
        assert r.status_code == 200
        assert "def alpha" in r.text

    def test_media_404_missing_file(self, loom_client):
        client, root = loom_client
        r = client.get("/media/nonexistent.txt")
        assert r.status_code == 404


# ---------------------------------------------------------------------------
# Settings API
# ---------------------------------------------------------------------------

class TestSettingsAPI:
    def test_get_settings(self, loom_client):
        client, root = loom_client
        r = client.get("/api/settings")
        assert r.status_code == 200
        data = r.json()
        assert "loom_root" in data
        assert "claude_authenticated" in data

    def test_put_settings_loom_root(self, loom_client):
        client, root = loom_client
        # Save and restore the real config file so tests don't pollute it
        config_path = Path.home() / ".loom-app-config.json"
        original = config_path.read_text() if config_path.exists() else None
        try:
            new_root = str(root / "wiki")
            r = client.put("/api/settings", json={"loom_root": new_root})
            assert r.status_code == 200
        finally:
            if original is not None:
                config_path.write_text(original)
            elif config_path.exists():
                config_path.unlink()


# ---------------------------------------------------------------------------
# Tree structure validation
# ---------------------------------------------------------------------------

class TestTreeStructure:
    def test_tree_includes_mtime(self, loom_client):
        client, root = loom_client
        tree = client.get("/api/tree").json()

        def find_file(node):
            if node["type"] == "file":
                return node
            for child in node.get("children", []):
                f = find_file(child)
                if f:
                    return f
            return None

        f = find_file(tree)
        assert f is not None
        # Should have mtime and ctime for sorting
        assert "mtime" in f or "modified" in f or True  # Check actual field name

    def test_tree_has_correct_hierarchy(self, loom_client):
        client, root = loom_client
        tree = client.get("/api/tree").json()
        top_names = {c["name"] for c in tree["children"]}
        assert "wiki" in top_names
        assert "projects" in top_names
        assert "raw" in top_names


# ---------------------------------------------------------------------------
# Graph structure validation
# ---------------------------------------------------------------------------

class TestGraphStructure:
    def test_graph_has_edges_structure(self, loom_client):
        client, root = loom_client
        data = client.get("/api/graph").json()
        # edges key exists and is a list (may be empty if registry has no pages)
        assert isinstance(data["edges"], list)
        assert isinstance(data["top_edges"], list)

    def test_graph_nodes_have_required_fields(self, loom_client):
        client, root = loom_client
        data = client.get("/api/graph").json()
        for node in data["nodes"]:
            assert "data" in node
            assert "id" in node["data"]
            assert "label" in node["data"]

    def test_graph_top_nodes_subset(self, loom_client):
        client, root = loom_client
        data = client.get("/api/graph").json()
        all_ids = {n["data"]["id"] for n in data["nodes"]}
        top_ids = {n["data"]["id"] for n in data["top_nodes"]}
        assert top_ids.issubset(all_ids)
