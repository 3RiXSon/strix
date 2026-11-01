"""Tests for the Docker-free ``local`` runtime backend (mobile/Termux path)."""

from __future__ import annotations

import io
from pathlib import Path
from typing import TYPE_CHECKING

import pytest

from strix.config import loader
from strix.runtime import capabilities, session_manager
from strix.runtime.backends import (
    backend_supports_bind_mounts,
    get_backend,
    resolve_backend_name,
    supported_backends,
)
from strix.runtime.local_backend import local_workspace_root


if TYPE_CHECKING:
    from collections.abc import Iterator


@pytest.fixture(autouse=True)
def _fresh_settings() -> Iterator[None]:
    loader._cached = None
    yield
    loader._cached = None


def test_local_and_auto_are_supported_backends() -> None:
    assert "local" in supported_backends()
    assert "auto" in supported_backends()
    assert get_backend("local") is not None
    assert backend_supports_bind_mounts("local") is False
    assert backend_supports_bind_mounts("docker") is True


def test_resolve_auto_falls_back_to_local_without_docker(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(capabilities, "docker_daemon_available", lambda **_kw: False)
    assert resolve_backend_name("auto") == "local"


def test_resolve_auto_prefers_docker_when_daemon_answers(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(capabilities, "docker_daemon_available", lambda **_kw: True)
    assert resolve_backend_name("auto") == "docker"


def test_resolve_passthrough_and_unknown_backend() -> None:
    assert resolve_backend_name("local") == "local"
    assert resolve_backend_name("docker") == "docker"
    with pytest.raises(ValueError, match="Unknown STRIX_RUNTIME_BACKEND"):
        get_backend("carrier-pigeon")


def test_local_workspace_root_override(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("STRIX_LOCAL_WORKSPACE", str(tmp_path / "ws"))
    assert local_workspace_root() == tmp_path / "ws"


def test_capabilities_report_tools_and_termux(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("TERMUX_VERSION", "0.118")
    caps = capabilities.detect_capabilities()
    assert caps["is_termux"] is True
    assert caps["docker"]["daemon"] in (True, False)
    assert "curl" in caps["tools"]


async def test_local_backend_session_lifecycle(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Full session: manifest entries, /workspace alias paths, exec, cleanup."""
    monkeypatch.setenv("STRIX_RUNTIME_BACKEND", "local")
    monkeypatch.setenv("STRIX_LOCAL_WORKSPACE", str(tmp_path / "ws"))
    monkeypatch.chdir(tmp_path)

    bundle = await session_manager.create_or_reuse(
        "scan-mobile-test",
        image="ignored-on-local",
        local_sources=[],
        extra_files=[{"workspace_path": "/workspace/note.txt", "content": "hello"}],
    )
    try:
        assert bundle["caido_client"] is None
        session = bundle["session"]

        result = await session.exec("cat note.txt && pwd")
        assert result.ok()
        assert b"hello" in result.stdout
        assert str(tmp_path / "ws") in result.stdout.decode()

        # Strix's own spill writer uses absolute /workspace paths; the local
        # session must translate them onto the real workspace root.
        await session.write(Path("/workspace/.tool-output/spill.txt"), io.BytesIO(b"spilled"))
        result = await session.exec("cat /workspace/.tool-output/spill.txt")
        assert result.stdout == b"spilled"
    finally:
        await session_manager.cleanup("scan-mobile-test")

    # Cleanup must not delete the operator's workspace (it is not a container).
    assert (tmp_path / "ws" / "note.txt").read_text(encoding="utf-8") == "hello"
