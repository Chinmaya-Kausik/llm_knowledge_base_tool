"""Codex adapter — wraps OpenAI's Codex CLI into the AgentAdapter interface."""

import asyncio
import logging
import shutil
from typing import Any, AsyncIterator

from loom_mcp.agents import AgentAdapter, AgentEvent

log = logging.getLogger("loom.agents.codex")


class CodexAdapter(AgentAdapter):
    """Agent adapter for OpenAI Codex CLI."""
    name = "codex"

    def __init__(self) -> None:
        self._process: asyncio.subprocess.Process | None = None
        self._cwd: str = "."
        self._command: str = "codex"

    async def connect(self, config: dict[str, Any]) -> None:
        """Verify codex is available.

        Config keys:
            loom_root: str — working directory
            command: str — codex binary name/path (default "codex")
        """
        self._cwd = config.get("loom_root", ".")
        self._command = config.get("command", "codex")

        if not shutil.which(self._command):
            raise RuntimeError(
                f"'{self._command}' not found in PATH. "
                f"Install it with: npm install -g @openai/codex"
            )

    async def query(self, prompt: str) -> None:
        """Spawn codex with the prompt."""
        self._process = await asyncio.create_subprocess_exec(
            self._command, prompt,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=self._cwd,
        )

    async def receive(self) -> AsyncIterator[AgentEvent]:
        """Stream codex stdout as AgentEvents."""
        if not self._process or not self._process.stdout:
            return

        buffer = ""
        while True:
            chunk = await self._process.stdout.read(4096)
            if not chunk:
                break
            text = chunk.decode(errors="replace")
            buffer += text

            # Emit line by line
            while "\n" in buffer:
                line, buffer = buffer.split("\n", 1)
                line = line.rstrip()
                if not line:
                    continue

                # Try to detect tool use patterns
                if line.startswith("Running: ") or line.startswith("> "):
                    yield AgentEvent(
                        type="tool_use",
                        data={"tool": "Bash", "input": {"command": line.lstrip("> ").removeprefix("Running: ")}},
                    )
                elif line.startswith("Output: ") or line.startswith("  "):
                    yield AgentEvent(type="tool_result", content=line)
                else:
                    yield AgentEvent(type="text", content=line + "\n")

        # Emit any remaining buffer
        if buffer.strip():
            yield AgentEvent(type="text", content=buffer)

        # Wait for process to finish
        await self._process.wait()
        exit_code = self._process.returncode

        # Read stderr for errors
        if self._process.stderr:
            stderr = await self._process.stderr.read()
            if stderr and exit_code != 0:
                yield AgentEvent(type="error", content=stderr.decode(errors="replace"))

        yield AgentEvent(
            type="result",
            content="",
            data={"exit_code": exit_code},
        )

    async def stop(self) -> None:
        """Kill the codex process."""
        if self._process and self._process.returncode is None:
            try:
                self._process.terminate()
                await asyncio.wait_for(self._process.wait(), timeout=3.0)
            except asyncio.TimeoutError:
                self._process.kill()

    async def disconnect(self) -> None:
        """Ensure process is cleaned up."""
        await self.stop()
        self._process = None
