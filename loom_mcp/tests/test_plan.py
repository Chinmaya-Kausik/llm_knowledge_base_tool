"""Tests for plan panel feature — API endpoints, chat transcript rendering, lifecycle."""

import tempfile
from pathlib import Path
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from loom_mcp.tools.compile import save_chat_transcript


# --- Chat transcript tests ---


def test_plan_proposed_renders_as_collapsible():
    """Plan with status 'proposed' renders as collapsible details block."""
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        messages = [
            {"role": "user", "content": "Add auth"},
            {"role": "plan", "content": "## Plan\n- [ ] Step 1\n- [ ] Step 2", "status": "proposed"},
        ]
        result = save_chat_transcript(root, "test-plan", messages)
        content = (root / result["path"]).read_text()
        assert "<details>" in content
        assert "Plan — proposed" in content
        assert "- [ ] Step 1" in content
        assert "- [ ] Step 2" in content


def test_plan_approved_renders_with_status():
    """Plan with status 'approved' shows approved in summary."""
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        messages = [
            {"role": "plan", "content": "- [x] Step 1\n- [ ] Step 2", "status": "proposed"},
            {"role": "plan", "content": "- [x] Step 1\n- [x] Step 2", "status": "approved"},
        ]
        result = save_chat_transcript(root, "test-approve", messages)
        content = (root / result["path"]).read_text()
        assert "Plan — proposed" in content
        assert "Plan — approved" in content


def test_plan_no_status():
    """Plan without status still renders as collapsible."""
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        messages = [
            {"role": "plan", "content": "Some plan content"},
        ]
        result = save_chat_transcript(root, "test-no-status", messages)
        content = (root / result["path"]).read_text()
        assert "<details>" in content
        assert "<summary>Plan</summary>" in content


def test_plan_mixed_with_other_messages():
    """Plan messages correctly interleave with other message types."""
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        messages = [
            {"role": "user", "content": "Build a feature"},
            {"role": "thinking", "content": "Let me plan this out"},
            {"role": "plan", "content": "- [ ] Design\n- [ ] Implement\n- [ ] Test", "status": "proposed"},
            {"role": "assistant", "content": "Here's my plan. What do you think?"},
            {"role": "user", "content": "Looks good, proceed"},
            {"role": "plan", "content": "- [x] Design\n- [ ] Implement\n- [ ] Test", "status": "approved"},
            {"role": "assistant", "content": "Starting implementation."},
        ]
        result = save_chat_transcript(root, "test-mixed", messages)
        content = (root / result["path"]).read_text()
        assert "## You" in content
        assert "## Claude" in content
        assert "Plan — proposed" in content
        assert "Plan — approved" in content
        assert content.index("proposed") < content.index("approved")


# --- API endpoint tests ---


@pytest.fixture
def loom_app():
    """Create a test loom with plan files and return a test client."""
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        # Create plans directory with a plan file
        plans_dir = root / ".claude" / "plans"
        plans_dir.mkdir(parents=True)
        plan_file = plans_dir / "test-plan.md"
        plan_file.write_text("# Plan\n- [ ] Step 1\n- [ ] Step 2\n")

        # Patch LOOM_ROOT and import app
        with patch("loom_mcp.web.LOOM_ROOT", root):
            from loom_mcp.web import app
            client = TestClient(app)
            yield client, root, plan_file


def test_api_get_plan(loom_app):
    """GET /api/plan returns the most recent plan file."""
    client, root, plan_file = loom_app
    resp = client.get("/api/plan")
    data = resp.json()
    assert data["ok"] is True
    assert "test-plan.md" in data["path"]
    assert "- [ ] Step 1" in data["content"]


def test_api_get_plan_no_files():
    """GET /api/plan returns error when no plan files exist."""
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        (root / ".claude" / "plans").mkdir(parents=True)
        with patch("loom_mcp.web.LOOM_ROOT", root):
            from loom_mcp.web import app
            client = TestClient(app)
            resp = client.get("/api/plan")
            data = resp.json()
            assert data["ok"] is False


def test_api_put_plan(loom_app):
    """PUT /api/plan updates plan file content."""
    client, root, plan_file = loom_app
    new_content = "# Plan\n- [x] Step 1\n- [ ] Step 2\n"
    resp = client.put("/api/plan", json={
        "path": str(plan_file.relative_to(root)),
        "content": new_content,
    })
    data = resp.json()
    assert data["ok"] is True
    assert plan_file.read_text() == new_content


def test_api_put_plan_invalid_path(loom_app):
    """PUT /api/plan rejects paths outside .claude/plans/."""
    client, root, plan_file = loom_app
    resp = client.put("/api/plan", json={
        "path": "wiki/README.md",
        "content": "hacked",
    })
    data = resp.json()
    assert data["ok"] is False


def test_api_delete_plan(loom_app):
    """DELETE /api/plan removes the plan file."""
    client, root, plan_file = loom_app
    assert plan_file.exists()
    resp = client.request("DELETE", "/api/plan", json={
        "path": str(plan_file.relative_to(root)),
    })
    data = resp.json()
    assert data["ok"] is True
    assert not plan_file.exists()


def test_api_delete_plan_invalid_path(loom_app):
    """DELETE /api/plan rejects paths outside .claude/plans/."""
    client, root, plan_file = loom_app
    resp = client.request("DELETE", "/api/plan", json={
        "path": "wiki/README.md",
    })
    data = resp.json()
    assert data["ok"] is False


def test_checkbox_round_trip(loom_app):
    """Toggling a checkbox via PUT preserves the rest of the plan."""
    client, root, plan_file = loom_app
    original = plan_file.read_text()
    assert "- [ ] Step 1" in original

    # Simulate checking Step 1
    updated = original.replace("- [ ] Step 1", "- [x] Step 1")
    client.put("/api/plan", json={
        "path": str(plan_file.relative_to(root)),
        "content": updated,
    })

    content = plan_file.read_text()
    assert "- [x] Step 1" in content
    assert "- [ ] Step 2" in content  # Unchanged


def test_plan_lifecycle():
    """Full lifecycle: create → edit → approve → delete."""
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        plans_dir = root / ".claude" / "plans"
        plans_dir.mkdir(parents=True)
        plan_file = plans_dir / "lifecycle-test.md"
        plan_file.write_text("- [ ] A\n- [ ] B\n")

        with patch("loom_mcp.web.LOOM_ROOT", root):
            from loom_mcp.web import app
            client = TestClient(app)

            # 1. Get plan
            resp = client.get("/api/plan")
            assert resp.json()["ok"] is True

            # 2. Update (check item A)
            client.put("/api/plan", json={
                "path": str(plan_file.relative_to(root)),
                "content": "- [x] A\n- [ ] B\n",
            })
            assert "- [x] A" in plan_file.read_text()

            # 3. Delete (after approval)
            client.request("DELETE", "/api/plan", json={
                "path": str(plan_file.relative_to(root)),
            })
            assert not plan_file.exists()

            # 4. Get plan returns error now
            resp = client.get("/api/plan")
            assert resp.json()["ok"] is False
