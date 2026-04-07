"""Subagent control — checkpoints, pause, rollback, redirect."""

import asyncio
import subprocess
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


@dataclass
class Checkpoint:
    """A snapshot of the working tree at a specific tool call."""
    id: str
    agent_id: str
    tool_name: str
    tool_input: dict
    timestamp: float
    git_ref: str  # SHA from git stash create
    modified_files: list[str]


@dataclass
class SubagentState:
    """Tracks a running subagent's state."""
    agent_id: str
    task_id: str
    description: str
    checkpoints: list[Checkpoint] = field(default_factory=list)
    is_paused: bool = False
    pause_event: asyncio.Event | None = None
    pending_result: dict | None = None  # Hook result to return on resume


class SubagentController:
    """Manages subagent checkpoints, pause, rollback, and redirect."""

    def __init__(self, loom_root: Path):
        self.loom_root = loom_root
        self.agents: dict[str, SubagentState] = {}  # agent_id → state
        self.baseline_ref: str | None = None
        self._init_baseline()

    def _init_baseline(self):
        """Record the current HEAD as baseline for rollbacks."""
        try:
            result = subprocess.run(
                ["git", "rev-parse", "HEAD"],
                cwd=str(self.loom_root), capture_output=True, text=True,
            )
            if result.returncode == 0:
                self.baseline_ref = result.stdout.strip()
        except Exception:
            pass

    def create_checkpoint(self, agent_id: str, tool_name: str, tool_input: dict) -> Checkpoint | None:
        """Create a checkpoint by snapshotting the current working tree."""
        try:
            # Get modified files
            diff_result = subprocess.run(
                ["git", "diff", "--name-only"],
                cwd=str(self.loom_root), capture_output=True, text=True,
            )
            modified = diff_result.stdout.strip().split("\n") if diff_result.stdout.strip() else []

            # Create a stash commit object (doesn't touch stash stack or HEAD)
            stash_result = subprocess.run(
                ["git", "stash", "create"],
                cwd=str(self.loom_root), capture_output=True, text=True,
            )
            git_ref = stash_result.stdout.strip() or "HEAD"

            checkpoint = Checkpoint(
                id=f"ckpt-{agent_id[:8]}-{len(self.agents.get(agent_id, SubagentState('', '')).checkpoints)}",
                agent_id=agent_id,
                tool_name=tool_name,
                tool_input=tool_input,
                timestamp=time.time(),
                git_ref=git_ref,
                modified_files=modified,
            )
            return checkpoint
        except Exception:
            return None

    def rollback_to_checkpoint(self, checkpoint: Checkpoint) -> list[str]:
        """Rollback the working tree to a checkpoint's state."""
        if not checkpoint.git_ref or checkpoint.git_ref == "HEAD":
            return []

        try:
            result = subprocess.run(
                ["git", "checkout", checkpoint.git_ref, "--", "."],
                cwd=str(self.loom_root), capture_output=True, text=True,
            )
            if result.returncode == 0:
                return checkpoint.modified_files
        except Exception:
            pass
        return []

    def register_agent(self, agent_id: str, task_id: str, description: str):
        """Register a new subagent."""
        self.agents[agent_id] = SubagentState(
            agent_id=agent_id, task_id=task_id, description=description,
        )

    def unregister_agent(self, agent_id: str):
        """Unregister a completed subagent (keep checkpoints for post-hoc rollback)."""
        state = self.agents.get(agent_id)
        if state:
            state.is_paused = False
            state.pause_event = None

    def pause_agent(self, agent_id: str):
        """Mark an agent for pausing (will pause at next PreToolUse hook)."""
        state = self.agents.get(agent_id)
        if state:
            state.is_paused = True

    def resume_agent(self, agent_id: str, hook_result: dict | None = None):
        """Resume a paused agent."""
        state = self.agents.get(agent_id)
        if state and state.pause_event:
            state.pending_result = hook_result
            state.is_paused = False
            state.pause_event.set()

    async def pre_tool_use_hook(
        self, hook_input: dict, tool_use_id: str | None, context: Any
    ) -> dict:
        """PreToolUse hook — creates checkpoints and handles pause."""
        agent_id = hook_input.get("agent_id")
        if agent_id is None:
            return {}  # Parent tool call — no checkpoint

        state = self.agents.get(agent_id)
        if state is None:
            return {}

        # Create checkpoint
        tool_name = hook_input.get("tool_name", "unknown")
        tool_input = hook_input.get("tool_input", {})
        checkpoint = self.create_checkpoint(agent_id, tool_name, tool_input)
        if checkpoint:
            state.checkpoints.append(checkpoint)

        # Check if paused
        if state.is_paused:
            state.pause_event = asyncio.Event()
            # Block here until user resumes
            try:
                await asyncio.wait_for(state.pause_event.wait(), timeout=300)
            except asyncio.TimeoutError:
                pass  # Resume after timeout

            if state.pending_result:
                result = state.pending_result
                state.pending_result = None
                return result

        return {}

    async def subagent_start_hook(
        self, hook_input: dict, tool_use_id: str | None, context: Any
    ) -> dict:
        """SubagentStart hook — register the subagent."""
        agent_id = hook_input.get("agent_id", "")
        self.register_agent(
            agent_id=agent_id,
            task_id=tool_use_id or "",
            description=hook_input.get("agent_type", "subagent"),
        )
        return {}

    async def subagent_stop_hook(
        self, hook_input: dict, tool_use_id: str | None, context: Any
    ) -> dict:
        """SubagentStop hook — mark subagent as complete."""
        agent_id = hook_input.get("agent_id", "")
        self.unregister_agent(agent_id)
        return {}
