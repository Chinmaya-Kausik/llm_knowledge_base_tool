"""Generic CLI adapter — wraps any stdin/stdout agent into the AgentAdapter interface."""

import asyncio
import logging
import shutil
from typing import Any, AsyncIterator

from loom_mcp.agents import AgentAdapter, AgentEvent

log = logging.getLogger("loom.agents.generic_cli")


class GenericCLIAdapter(AgentAdapter):
    """Agent adapter for any CLI tool that reads stdin and writes stdout.

    Works with Aider, custom scripts, or any interactive CLI agent.
    """
    name = "generic-cli"

    def __init__(self) -> None:
        self._process: asyncio.subprocess.Process | None = None
        self._command: str = ""
        self._args: list[str] = []
        self._cwd: str = "."

    async def connect(self, config: dict[str, Any]) -> None:
        """Spawn the CLI process.

        Config keys:
            loom_root: str — working directory
            command: str — binary name/path
            args: list[str] — additional arguments
        """
        self._cwd = config.get("loom_root", ".")
        self._command = config.get("command", "")
        self._args = config.get("args", [])

        if not self._command:
            raise RuntimeError("No command specified for generic CLI agent")
        if not shutil.which(self._command):
            raise RuntimeError(f"'{self._command}' not found in PATH")

        self._process = await asyncio.create_subprocess_exec(
            self._command, *self._args,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=self._cwd,
        )

    async def query(self, prompt: str) -> None:
        """Write the prompt to stdin."""
        if not self._process or not self._process.stdin:
            raise RuntimeError("Not connected")
        self._process.stdin.write((prompt + "\n").encode())
        await self._process.stdin.drain()

    async def receive(self) -> AsyncIterator[AgentEvent]:
        """Stream stdout as text events."""
        if not self._process or not self._process.stdout:
            return

        while True:
            try:
                line = await asyncio.wait_for(
                    self._process.stdout.readline(),
                    timeout=120,  # 2 min timeout for idle
                )
            except asyncio.TimeoutError:
                yield AgentEvent(type="done")
                return

            if not line:
                # Process exited
                break

            text = line.decode(errors="replace")
            yield AgentEvent(type="text", content=text)

        # Check exit status
        if self._process.returncode is not None and self._process.returncode != 0:
            if self._process.stderr:
                stderr = await self._process.stderr.read()
                if stderr:
                    yield AgentEvent(type="error", content=stderr.decode(errors="replace"))

    async def stop(self) -> None:
        """Terminate the process."""
        if self._process and self._process.returncode is None:
            try:
                self._process.terminate()
                await asyncio.wait_for(self._process.wait(), timeout=3.0)
            except asyncio.TimeoutError:
                self._process.kill()

    async def disconnect(self) -> None:
        """Clean up."""
        if self._process:
            if self._process.stdin:
                try:
                    self._process.stdin.close()
                except Exception:
                    pass
            await self.stop()
            self._process = None
