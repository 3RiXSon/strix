"""Host capability detection — what can this machine actually run?

Strix was built for a Docker sandbox full of Kali tools. Phones, Termux,
containers without a daemon, and minimal VPS images have subsets of that.
Everything that degrades (the ``local`` backend, ``strix mobile``) asks this
module what is present instead of assuming, so the UI and the agent can be
told the truth up front rather than failing mid-scan.
"""

from __future__ import annotations

import os
import platform
import shutil
import subprocess
import sys
from typing import Any

from strix.config import load_settings


# Tools the sandbox image ships (containers/Dockerfile) that agents reach for
# through the shell. Presence here is advisory: it drives the mobile status
# screen and the local-workspace notice, never a hard gate.
KNOWN_TOOLS: tuple[str, ...] = (
    "curl",
    "git",
    "python3",
    "node",
    "nmap",
    "nuclei",
    "sqlmap",
    "ffuf",
    "subfinder",
    "naabu",
    "httpx",
    "katana",
    "chromium",
    "agent-browser",
    "caido-cli",
)

_docker_daemon_cache: bool | None = None


def is_termux() -> bool:
    """True inside Android Termux (no Docker daemon, no writable ``/``)."""
    if os.environ.get("TERMUX_VERSION"):
        return True
    return "com.termux" in os.environ.get("PREFIX", "")


def is_android() -> bool:
    return bool(os.environ.get("ANDROID_ROOT") or os.environ.get("ANDROID_DATA")) or is_termux()


def docker_cli_available() -> bool:
    return shutil.which("docker") is not None


def docker_daemon_available(*, refresh: bool = False) -> bool:
    """True when a Docker daemon answers. Probing is cached: ``docker info``
    can take seconds against a dead socket, and callers poll."""
    global _docker_daemon_cache  # noqa: PLW0603
    if _docker_daemon_cache is not None and not refresh:
        return _docker_daemon_cache
    available = False
    if docker_cli_available():
        try:
            result = subprocess.run(
                ["docker", "info", "--format", "{{.ServerVersion}}"],  # noqa: S607
                capture_output=True,
                timeout=4,
                check=False,
            )
            available = result.returncode == 0 and bool(result.stdout.strip())
        except (OSError, subprocess.TimeoutExpired):
            available = False
    _docker_daemon_cache = available
    return available


def detect_tools() -> dict[str, str | None]:
    """Map each known tool to its resolved path, or None when absent."""
    return {name: shutil.which(name) for name in KNOWN_TOOLS}


def detect_capabilities() -> dict[str, Any]:
    """Full capability snapshot for status endpoints and startup decisions."""
    settings = load_settings()
    configured_backend = settings.runtime.backend
    tools = detect_tools()
    return {
        "platform": sys.platform,
        "platform_release": platform.release(),
        "python": platform.python_version(),
        "is_termux": is_termux(),
        "is_android": is_android(),
        "is_ios": sys.platform == "ios",
        "docker": {
            "cli": docker_cli_available(),
            "daemon": docker_daemon_available(),
        },
        "backend_configured": configured_backend,
        "llm": {
            "model": settings.llm.model,
            "configured": bool(settings.llm.model),
            "api_key_set": bool(settings.llm.api_key),
            "api_base": settings.llm.api_base,
        },
        "tools": tools,
        "tools_available": sorted(name for name, path in tools.items() if path),
        "tools_missing": sorted(name for name, path in tools.items() if not path),
    }


__all__ = [
    "KNOWN_TOOLS",
    "detect_capabilities",
    "detect_tools",
    "docker_cli_available",
    "docker_daemon_available",
    "is_android",
    "is_termux",
]
