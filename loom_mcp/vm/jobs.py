"""Job management — start, stop, monitor long-running processes on VMs."""

import json
import logging
import time
import uuid
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Any

log = logging.getLogger(__name__)


@dataclass
class Job:
    """A tracked job running on a VM."""
    id: str
    vm_id: str
    name: str
    command: str
    pid: int
    status: str  # "running", "completed", "failed", "stopped"
    started: float  # Unix timestamp
    stopped: float | None = None
    exit_code: int | None = None
    output_file: str = ""  # Remote path to stdout/stderr log


def _jobs_path(loom_root: Path) -> Path:
    return loom_root / ".loom" / "vm-jobs.json"


def load_jobs(loom_root: Path) -> list[dict[str, Any]]:
    """Load all tracked jobs from disk."""
    path = _jobs_path(loom_root)
    if not path.exists():
        return []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data.get("jobs", [])
    except (json.JSONDecodeError, KeyError):
        return []


def save_jobs(loom_root: Path, jobs: list[dict[str, Any]]) -> None:
    """Save all tracked jobs to disk."""
    path = _jobs_path(loom_root)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"jobs": jobs}, indent=2), encoding="utf-8")


def get_vm_jobs(loom_root: Path, vm_id: str) -> list[dict[str, Any]]:
    """Get jobs for a specific VM."""
    return [j for j in load_jobs(loom_root) if j.get("vm_id") == vm_id]


async def start_job(ssh_pool: Any, vm_config: dict[str, Any],
                    loom_root: Path, name: str, command: str) -> dict[str, Any]:
    """Start a long-running job on a VM via nohup. Returns Job dict."""
    vm_id = vm_config["id"]
    job_id = str(uuid.uuid4())[:8]
    output_file = f"/tmp/loom-job-{job_id}.log"

    # Run via nohup with output redirection, get PID
    start_cmd = (
        f"nohup bash -c {_shell_escape(command)} "
        f"> {output_file} 2>&1 & echo $!"
    )
    result = await ssh_pool.exec_command(vm_config, start_cmd, timeout=10)

    if result["exit_code"] != 0:
        return {"ok": False, "error": result["stderr"]}

    pid_str = result["stdout"].strip().splitlines()[-1]
    try:
        pid = int(pid_str)
    except ValueError:
        return {"ok": False, "error": f"Could not parse PID: {pid_str}"}

    job = {
        "id": job_id,
        "vm_id": vm_id,
        "name": name,
        "command": command,
        "pid": pid,
        "status": "running",
        "started": time.time(),
        "stopped": None,
        "exit_code": None,
        "output_file": output_file,
    }

    jobs = load_jobs(loom_root)
    jobs.append(job)
    save_jobs(loom_root, jobs)
    return {"ok": True, "job": job}


async def stop_job(ssh_pool: Any, vm_config: dict[str, Any],
                   loom_root: Path, job_id: str) -> dict[str, Any]:
    """Stop a running job on a VM."""
    jobs = load_jobs(loom_root)
    job = next((j for j in jobs if j["id"] == job_id), None)
    if not job:
        return {"ok": False, "error": "Job not found"}
    if job["status"] != "running":
        return {"ok": False, "error": f"Job is {job['status']}, not running"}

    # Send SIGTERM, then SIGKILL after 5s
    pid = job["pid"]
    await ssh_pool.exec_command(vm_config, f"kill {pid} 2>/dev/null", timeout=5)
    await ssh_pool.exec_command(vm_config, f"sleep 2 && kill -0 {pid} 2>/dev/null && kill -9 {pid} 2>/dev/null", timeout=10)

    job["status"] = "stopped"
    job["stopped"] = time.time()
    save_jobs(loom_root, jobs)
    return {"ok": True}


async def refresh_job_status(ssh_pool: Any, vm_config: dict[str, Any],
                             loom_root: Path) -> list[dict[str, Any]]:
    """Check which tracked jobs are still running. Updates statuses."""
    vm_id = vm_config["id"]
    jobs = load_jobs(loom_root)
    vm_jobs = [j for j in jobs if j["vm_id"] == vm_id and j["status"] == "running"]

    if not vm_jobs:
        return [j for j in jobs if j["vm_id"] == vm_id]

    pids = [str(j["pid"]) for j in vm_jobs]
    # Check which PIDs are alive
    result = await ssh_pool.exec_command(
        vm_config,
        f"for pid in {' '.join(pids)}; do kill -0 $pid 2>/dev/null && echo $pid; done",
        timeout=10,
    )
    alive_pids = set(result["stdout"].strip().splitlines())

    changed = False
    for job in vm_jobs:
        if str(job["pid"]) not in alive_pids:
            job["status"] = "completed"
            job["stopped"] = time.time()
            # Try to get exit code
            exit_result = await ssh_pool.exec_command(
                vm_config,
                f"wait {job['pid']} 2>/dev/null; echo $?",
                timeout=5,
            )
            try:
                job["exit_code"] = int(exit_result["stdout"].strip())
            except ValueError:
                job["exit_code"] = None
            changed = True
            # Send ntfy notification
            try:
                from loom_mcp.notify import notify_job_done
                notify_job_done(job["name"], vm_config.get("label", ""), job["exit_code"])
            except Exception:
                pass

    if changed:
        save_jobs(loom_root, jobs)

    return [j for j in jobs if j["vm_id"] == vm_id]


async def get_job_output(ssh_pool: Any, vm_config: dict[str, Any],
                         job_id: str, loom_root: Path, tail: int = 100) -> str:
    """Get the last N lines of a job's output."""
    jobs = load_jobs(loom_root)
    job = next((j for j in jobs if j["id"] == job_id), None)
    if not job:
        return ""
    result = await ssh_pool.exec_command(
        vm_config,
        f"tail -n {tail} {job['output_file']} 2>/dev/null",
        timeout=10,
    )
    return result["stdout"]


def _shell_escape(s: str) -> str:
    """Escape a string for use in shell single quotes."""
    return "'" + s.replace("'", "'\\''") + "'"
