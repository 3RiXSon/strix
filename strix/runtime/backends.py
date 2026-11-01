"""Sandbox backend registry — selected via STRIX_RUNTIME_BACKEND (default: docker)."""

from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable
from typing import TYPE_CHECKING, Any


if TYPE_CHECKING:
    from agents.sandbox.manifest import Manifest


logger = logging.getLogger(__name__)


SandboxBackend = Callable[..., Awaitable[tuple[Any, Any]]]


async def _docker_backend(
    *,
    image: str,
    manifest: Manifest,
    exposed_ports: tuple[int, ...],
    bind_mounts: list[dict[str, Any]] | None = None,
) -> tuple[Any, Any]:
    """Bring up a session backed by the local Docker daemon.

    Uses :class:`StrixDockerSandboxClient` to inject NET_ADMIN /
    NET_RAW caps + ``host.docker.internal`` host-gateway. Imports
    ``docker`` lazily so deployments that target a non-Docker
    backend don't need the docker-py library installed.

    ``session.start()`` is what materializes the manifest into the running
    container — the SDK's ``client.create()`` only builds the inner session
    object without applying it. ``async with session:`` would call it too, but
    Strix manages session lifetime explicitly via ``client.delete()`` so we
    trigger ``start()`` ourselves.
    """
    import docker
    from agents.sandbox.sandboxes.docker import DockerSandboxClientOptions

    from strix.runtime.docker_client import StrixDockerSandboxClient

    client = StrixDockerSandboxClient(docker.from_env())
    client.strix_bind_mounts = bind_mounts or []
    options = DockerSandboxClientOptions(image=image, exposed_ports=exposed_ports)
    session = await client.create(options=options, manifest=manifest)
    await session.start()
    return client, session


async def _local_backend(
    *,
    image: str,
    manifest: Manifest,
    exposed_ports: tuple[int, ...],
    bind_mounts: list[dict[str, Any]] | None = None,
) -> tuple[Any, Any]:
    """Host-directory backend for machines with no Docker daemon (phones,
    Termux, minimal VPS). Imported lazily like the Docker backend so merely
    importing this registry never pulls the SDK's sandbox stack."""
    from strix.runtime.local_backend import local_backend

    return await local_backend(
        image=image,
        manifest=manifest,
        exposed_ports=exposed_ports,
        bind_mounts=bind_mounts,
    )


_BACKENDS: dict[str, SandboxBackend] = {
    "docker": _docker_backend,
    "local": _local_backend,
}

_BIND_MOUNT_BACKENDS: set[str] = {"docker"}


def resolve_backend_name(name: str) -> str:
    """Resolve ``auto`` to a concrete backend based on what the host has.

    ``auto`` picks Docker when a daemon actually answers (full isolation,
    Kali tooling, Caido) and falls back to ``local`` when it does not — the
    phone/Termux case. Any other value passes through unchanged so typos
    still surface in :func:`get_backend`.
    """
    if name != "auto":
        return name
    from strix.runtime.capabilities import docker_daemon_available

    resolved = "docker" if docker_daemon_available() else "local"
    logger.info("STRIX_RUNTIME_BACKEND=auto resolved to %r", resolved)
    return resolved


def get_backend(name: str) -> SandboxBackend:
    """Return the backend factory for ``name`` or raise.

    Args:
        name: Backend identifier (e.g. ``"docker"``). Match is exact;
            no fallback. Unknown values raise so config typos surface
            immediately instead of silently picking a default.
    """
    backend = _BACKENDS.get(resolve_backend_name(name))
    if backend is None:
        supported = ", ".join([*sorted(_BACKENDS), "auto"])
        raise ValueError(
            f"Unknown STRIX_RUNTIME_BACKEND: {name!r} (supported: {supported})",
        )
    logger.debug("Selected sandbox backend: %s", name)
    return backend


def register_backend(
    name: str,
    backend: SandboxBackend,
    *,
    supports_bind_mounts: bool = False,
) -> None:
    """Register a custom backend under ``name``.

    Intended for downstream users who ship their own runtime — register
    before any ``session_manager.create_or_reuse`` call. Re-registering
    an existing name overwrites the prior entry. ``supports_bind_mounts``
    defaults to False: a remote runtime cannot see the caller's filesystem, so
    it is handed local sources as manifest entries to upload instead.
    """
    _BACKENDS[name] = backend
    if supports_bind_mounts:
        _BIND_MOUNT_BACKENDS.add(name)
    else:
        _BIND_MOUNT_BACKENDS.discard(name)
    logger.info("Registered sandbox backend: %s (bind mounts: %s)", name, supports_bind_mounts)


def backend_supports_bind_mounts(name: str) -> bool:
    return resolve_backend_name(name) in _BIND_MOUNT_BACKENDS


def supported_backends() -> list[str]:
    return [*sorted(_BACKENDS), "auto"]
