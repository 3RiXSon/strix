"""``local`` sandbox backend — run agent tools on the host, no Docker.

Why this exists: Docker is the hard blocker for running Strix on a phone.
Android (Termux) has no usable Docker daemon and iOS has neither Docker nor
a general-purpose Python runtime. The OpenAI Agents SDK already ships a
``UnixLocalSandboxClient`` that executes against a host directory with the
same session interface (``exec``/``read``/``write``/PTY) the Docker session
exposes, so the workaround is to back the scan with that instead of a
container.

Trade-offs, stated plainly:

- **No isolation.** Agent shell commands run as the invoking user on the
  host. Only use this on a device/account dedicated to testing, exactly as
  you would running a pentest tool by hand in Termux.
- **No Caido sidecar, no Kali image.** Proxy tools report themselves
  unavailable (they already degrade when ``caido_client`` is None) and the
  agent only has whatever tools are installed on the host — see
  :mod:`strix.runtime.capabilities`. Direct ``curl``/``nmap``/etc. from the
  shell still work.
- **Workspace path alias.** Prompts and several tools speak in absolute
  ``/workspace/...`` paths, which a container guarantees but a phone cannot
  (Android's ``/`` is read-only). The session below translates that prefix
  to the real workspace directory, and best-effort symlinks ``/workspace``
  to it on hosts where that is permitted so raw shell commands agree.
"""

from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import TYPE_CHECKING, Any


if TYPE_CHECKING:
    from agents.sandbox.manifest import Manifest


logger = logging.getLogger(__name__)

_WORKSPACE_PREFIX = "/workspace"


def local_workspace_root() -> Path:
    """Directory the local backend uses as its workspace root.

    ``STRIX_LOCAL_WORKSPACE`` wins. Otherwise ``/workspace`` when it already
    exists and is writable (typical root-owned VPS/container), else a
    per-user directory under ``~/.strix/`` — the only location guaranteed
    writable on Termux and unprivileged desktops alike.
    """
    override = os.environ.get("STRIX_LOCAL_WORKSPACE", "").strip()
    if override:
        return Path(override).expanduser()
    candidate = Path(_WORKSPACE_PREFIX)
    if candidate.is_dir() and os.access(candidate, os.W_OK):
        return candidate
    return Path.home() / ".strix" / "local-workspace"


def _alias_workspace(root: Path) -> None:
    """Best-effort ``/workspace`` → ``root`` symlink for raw shell commands.

    Only attempted when ``/workspace`` does not exist and its parent is
    writable; never touches an existing path (on a dev machine ``/workspace``
    may be a real checkout). Failure is expected on Android and ignored —
    the session's path translation covers the SDK-level tools there.
    """
    if root == Path(_WORKSPACE_PREFIX):
        return
    alias = Path(_WORKSPACE_PREFIX)
    try:
        if not alias.exists() and not alias.is_symlink():
            alias.symlink_to(root, target_is_directory=True)
            logger.info("Aliased %s -> %s for local backend", alias, root)
    except OSError:
        logger.debug("could not alias /workspace to %s", root, exc_info=True)


def _make_local_session_class() -> type:
    """Subclass of the SDK session that translates ``/workspace`` paths."""
    from agents.sandbox.sandboxes.unix_local import UnixLocalSandboxSession

    class StrixLocalSandboxSession(UnixLocalSandboxSession):
        """Unix-local session with a ``/workspace`` prefix translation.

        The SDK's workspace policy only accepts paths under the manifest
        root, so an agent (or Strix's own spill writer) asking for
        ``/workspace/x`` would be rejected when the real root is e.g.
        ``~/.strix/local-workspace``. Rewriting the prefix before the
        policy sees the path keeps every existing call site working.
        """

        def _translate(self, value: str) -> str:
            root = str(self.state.manifest.root)
            if root == _WORKSPACE_PREFIX:
                return value
            if value == _WORKSPACE_PREFIX:
                return root
            if value.startswith(f"{_WORKSPACE_PREFIX}/"):
                return f"{root}{value[len(_WORKSPACE_PREFIX) :]}"
            return value

        def normalize_path(self, path: Path | str, *, for_write: bool = False) -> Path:
            return super().normalize_path(self._translate(str(path)), for_write=for_write)

        async def exec(self, *command: Any, **kwargs: Any) -> Any:
            root = str(self.state.manifest.root)
            if root != _WORKSPACE_PREFIX:
                command = tuple(str(arg).replace(_WORKSPACE_PREFIX, root) for arg in command)
            return await super().exec(*command, **kwargs)

    return StrixLocalSandboxSession


async def local_backend(
    *,
    image: str,
    manifest: Manifest,
    exposed_ports: tuple[int, ...],
    bind_mounts: list[dict[str, Any]] | None = None,
) -> tuple[Any, Any]:
    """Bring up a session backed by a host directory (SDK UnixLocal client).

    ``image``/``exposed_ports``/``bind_mounts`` are accepted for signature
    compatibility with the Docker backend and ignored: there is no image to
    pull and no port to publish. Local sources arrive as manifest entries,
    which the SDK materializes into the workspace itself.
    """
    del image, exposed_ports, bind_mounts
    from agents.sandbox.sandboxes.unix_local import (
        UnixLocalSandboxClient,
        UnixLocalSandboxClientOptions,
    )

    root = local_workspace_root()
    root.mkdir(parents=True, exist_ok=True)
    _alias_workspace(root)

    # The SDK replaces a manifest whose root is its default ("/workspace")
    # with an isolated temp dir it owns and deletes. We want a stable,
    # inspectable workspace, so always hand it our explicit root; the
    # session subclass keeps "/workspace/..." spellings working on top.
    manifest = manifest.model_copy(update={"root": str(root)}, deep=True)

    client = UnixLocalSandboxClient()
    session = await client.create(
        options=UnixLocalSandboxClientOptions(exposed_ports=()),
        manifest=manifest,
    )
    # Same class-swap precedent as StrixDockerSandboxClient.create: the SDK
    # constructs the inner session, we retarget it to our subclass.
    inner = session._inner
    inner.__class__ = _make_local_session_class()
    await session.start()
    logger.info("Local sandbox session ready (workspace=%s)", root)
    return client, session


__all__ = ["local_backend", "local_workspace_root"]
