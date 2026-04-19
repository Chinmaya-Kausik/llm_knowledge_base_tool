"""Resource metric polling for VMs — CPU, RAM, disk, GPU."""

import logging
import re
from typing import Any

log = logging.getLogger(__name__)

# Command to gather all metrics in one SSH exec
METRICS_COMMAND = (
    "echo '---CPU---' && top -bn1 -p0 2>/dev/null | head -5 || uptime; "
    "echo '---MEM---' && free -m 2>/dev/null || vm_stat 2>/dev/null; "
    "echo '---DISK---' && df -h / 2>/dev/null; "
    "echo '---GPU---' && nvidia-smi --query-gpu=utilization.gpu,memory.used,memory.total "
    "--format=csv,noheader,nounits 2>/dev/null || echo 'no-gpu'"
)


def parse_metrics(stdout: str) -> dict[str, Any]:
    """Parse metrics command output into structured data."""
    sections = _split_sections(stdout)

    result: dict[str, Any] = {
        "cpu_pct": 0.0,
        "ram_used_mb": 0,
        "ram_total_mb": 0,
        "disk_used_gb": 0.0,
        "disk_total_gb": 0.0,
        "gpu_pct": None,
        "vram_used_mb": None,
        "vram_total_mb": None,
    }

    # Parse CPU
    cpu_text = sections.get("CPU", "")
    cpu_match = re.search(r"(\d+\.?\d*)\s*(?:id|idle)", cpu_text)
    if cpu_match:
        result["cpu_pct"] = round(100.0 - float(cpu_match.group(1)), 1)
    else:
        # Try load average from uptime
        load_match = re.search(r"load average[s]?:\s*([\d.]+)", cpu_text)
        if load_match:
            result["cpu_pct"] = round(float(load_match.group(1)) * 100, 1)

    # Parse RAM
    mem_text = sections.get("MEM", "")
    mem_match = re.search(r"Mem:\s+(\d+)\s+(\d+)", mem_text)
    if mem_match:
        result["ram_total_mb"] = int(mem_match.group(1))
        result["ram_used_mb"] = int(mem_match.group(2))

    # Parse Disk
    disk_text = sections.get("DISK", "")
    for line in disk_text.splitlines():
        if "/" == line.split()[-1] if line.split() else False:
            parts = line.split()
            if len(parts) >= 4:
                result["disk_total_gb"] = _parse_size_gb(parts[1])
                result["disk_used_gb"] = _parse_size_gb(parts[2])
            break

    # Parse GPU
    gpu_text = sections.get("GPU", "").strip()
    if gpu_text and gpu_text != "no-gpu":
        gpu_parts = gpu_text.split(",")
        if len(gpu_parts) >= 3:
            try:
                result["gpu_pct"] = float(gpu_parts[0].strip())
                result["vram_used_mb"] = int(gpu_parts[1].strip())
                result["vram_total_mb"] = int(gpu_parts[2].strip())
            except (ValueError, IndexError):
                pass

    return result


def _split_sections(stdout: str) -> dict[str, str]:
    """Split command output by ---SECTION--- markers."""
    sections: dict[str, str] = {}
    current_key = ""
    current_lines: list[str] = []

    for line in stdout.splitlines():
        if line.startswith("---") and line.endswith("---"):
            if current_key:
                sections[current_key] = "\n".join(current_lines)
            current_key = line.strip("-")
            current_lines = []
        else:
            current_lines.append(line)

    if current_key:
        sections[current_key] = "\n".join(current_lines)

    return sections


def _parse_size_gb(s: str) -> float:
    """Parse size strings like '50G', '500M', '1.5T' to GB."""
    s = s.strip()
    try:
        if s.endswith("T"):
            return float(s[:-1]) * 1024
        elif s.endswith("G"):
            return float(s[:-1])
        elif s.endswith("M"):
            return float(s[:-1]) / 1024
        elif s.endswith("K"):
            return float(s[:-1]) / (1024 * 1024)
        else:
            return float(s)
    except ValueError:
        return 0.0
