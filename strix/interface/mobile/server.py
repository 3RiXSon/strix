"""Strix Mobile HTTP server — stdlib only, like the run viewer.

Serves the installable PWA shell plus a small JSON API to launch, watch,
stop, and resume scans from a phone. Auth mirrors the viewer's model: the
operator opens a URL carrying a per-process bootstrap token, which is
exchanged for an HttpOnly session cookie; every API route requires that
cookie, so merely reaching the port on a LAN is not enough to start scans
(with a phone-typed target, that would be remote code execution).
"""

from __future__ import annotations

import json
import logging
import mimetypes
import re
import secrets
import threading
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, unquote, urlencode, urlsplit

from strix.core.paths import run_record_path, runs_base_dir
from strix.interface.mobile.jobs import (
    JobManager,
    load_mobile_config,
    public_config,
    save_mobile_config,
)
from strix.interface.viewer.transcript import (
    build_run_state,
    read_report_markdown,
    read_run_summary,
    read_vulnerabilities,
    severity_counts,
)
from strix.runtime.backends import resolve_backend_name
from strix.runtime.capabilities import detect_capabilities


logger = logging.getLogger(__name__)

SESSION_COOKIE_PREFIX = "strix_mobile_session"
_MAX_TARGETS = 10
_MAX_TARGET_LEN = 2048
_MAX_INSTRUCTIONS = 4000
_RUN_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
_SCAN_MODES = ("quick", "standard", "deep")
_BACKENDS = ("auto", "docker", "local")


def static_dir() -> Path:
    return Path(__file__).resolve().parent / "static"


class _MobileState:
    def __init__(self, jobs: JobManager) -> None:
        self.jobs = jobs
        self.base_dir = runs_base_dir()
        self.session_token = secrets.token_urlsafe(32)
        self.cookie_name = SESSION_COOKIE_PREFIX


def _valid_run_name(name: str) -> bool:
    return bool(_RUN_NAME_RE.match(name)) and ".." not in name


def _run_dir(state: _MobileState, name: str) -> Path | None:
    if not _valid_run_name(name):
        return None
    candidate = (state.base_dir / name).resolve()
    if candidate.parent != state.base_dir.resolve():
        return None
    return candidate if run_record_path(candidate).is_file() else None


def _scan_payload(state: _MobileState, run_dir: Path) -> dict[str, Any]:
    summary = read_run_summary(run_dir)
    vulns = read_vulnerabilities(run_dir)
    job = state.jobs.get(run_dir.name)
    return {
        "name": run_dir.name,
        "summary": summary,
        "job": job,
        "severity_counts": severity_counts(vulns),
        "vulnerabilities": vulns,
        "report_markdown": read_report_markdown(run_dir),
    }


def _validate_scan_body(body: dict[str, Any]) -> tuple[dict[str, Any] | None, str | None]:
    """Validate a POST /api/scans body. Returns (kwargs, error_code)."""
    raw_targets = body.get("targets")
    if isinstance(raw_targets, str):
        raw_targets = [line.strip() for line in raw_targets.splitlines() if line.strip()]
    targets: list[str] = []
    error: str | None = None
    if not isinstance(raw_targets, list) or not raw_targets:
        error = "invalid_target"
    else:
        targets = [str(target).strip() for target in raw_targets]
        if len(targets) > _MAX_TARGETS or any(
            not target or len(target) > _MAX_TARGET_LEN for target in targets
        ):
            error = "invalid_target"
    scan_mode = str(body.get("scan_mode") or "quick")
    if error is None and scan_mode not in _SCAN_MODES:
        error = "invalid_scan_mode"
    instructions = body.get("instructions")
    if instructions is not None:
        instructions = str(instructions).strip() or None
        if error is None and instructions and len(instructions) > _MAX_INSTRUCTIONS:
            error = "invalid_instructions"
    budget = body.get("max_budget_usd")
    if budget is not None:
        try:
            budget = float(budget)
            if not (0 < budget < 1_000_000):
                error = error or "invalid_budget"
        except (TypeError, ValueError):
            error = error or "invalid_budget"
    if error is not None:
        return None, error
    return {
        "targets": targets,
        "scan_mode": scan_mode,
        "instructions": instructions,
        "max_budget_usd": budget,
    }, None


def _make_handler(state: _MobileState) -> type[BaseHTTPRequestHandler]:
    class MobileHandler(BaseHTTPRequestHandler):
        server_version = "StrixMobile/1.0"

        def log_message(self, format: str, *args: Any) -> None:  # noqa: A002
            logger.debug("mobile %s - %s", self.address_string(), format % args)

        # -- plumbing ------------------------------------------------------

        def _send_json(self, status: HTTPStatus, payload: Any) -> None:
            body = json.dumps(payload).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def _read_body(self) -> dict[str, Any]:
            length = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(min(length, 1_000_000)) if length else b""
            try:
                body = json.loads(raw or b"{}")
            except json.JSONDecodeError:
                return {}
            return body if isinstance(body, dict) else {}

        def _has_session(self) -> bool:
            jar = {}
            for chunk in (self.headers.get("Cookie") or "").split(";"):
                name, sep, value = chunk.strip().partition("=")
                if sep:
                    jar[name] = value
            supplied = jar.get(state.cookie_name, "")
            return bool(supplied) and secrets.compare_digest(supplied, state.session_token)

        def _require_session(self) -> bool:
            if self._has_session():
                return True
            self._send_json(HTTPStatus.FORBIDDEN, {"error": "forbidden"})
            return False

        # -- routing ---------------------------------------------------------

        def do_GET(self) -> None:
            parts = urlsplit(self.path)
            path = parts.path
            try:
                if path.startswith("/api/"):
                    if self._require_session():
                        self._handle_api_get(path)
                else:
                    self._handle_static(path, parts.query)
            except BrokenPipeError:
                logger.debug("mobile client disconnected during %s", path)
            except Exception:
                logger.exception("mobile request failed: %s", path)
                self._send_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": "internal error"})

        def do_POST(self) -> None:
            path = urlsplit(self.path).path
            try:
                if not self._require_session():
                    return
                if path == "/api/scans":
                    self._handle_start()
                elif path == "/api/config":
                    self._handle_config()
                elif path.startswith("/api/scans/") and path.endswith("/stop"):
                    self._handle_stop(path)
                elif path.startswith("/api/scans/") and path.endswith("/resume"):
                    self._handle_resume(path)
                else:
                    self._send_json(HTTPStatus.NOT_FOUND, {"error": "unknown endpoint"})
            except BrokenPipeError:
                logger.debug("mobile client disconnected during POST %s", path)
            except Exception:
                logger.exception("mobile request failed: POST %s", path)
                self._send_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": "internal error"})

        # -- API ---------------------------------------------------------------

        def _handle_api_get(self, path: str) -> None:
            if path == "/api/status":
                caps = detect_capabilities()
                caps["backend_resolved"] = resolve_backend_name(
                    str(caps.get("backend_configured") or "auto"),
                )
                self._send_json(HTTPStatus.OK, caps)
            elif path == "/api/config":
                self._send_json(HTTPStatus.OK, public_config())
            elif path == "/api/scans":
                self._send_json(HTTPStatus.OK, {"jobs": state.jobs.list_jobs()})
            elif path.startswith("/api/scans/"):
                self._handle_scan_get(path)
            else:
                self._send_json(HTTPStatus.NOT_FOUND, {"error": "unknown endpoint"})

        def _handle_scan_get(self, path: str) -> None:
            rest = path[len("/api/scans/") :]
            name, _, tail = rest.partition("/")
            if tail == "log":
                job = state.jobs.get(name)
                self._send_json(HTTPStatus.OK, {"log": state.jobs.log_tail(name) if job else ""})
                return
            run_dir = _run_dir(state, name)
            if run_dir is None:
                job = state.jobs.get(name)
                if job is not None:
                    self._send_json(HTTPStatus.OK, {"job": job, "summary": None})
                else:
                    self._send_json(HTTPStatus.NOT_FOUND, {"error": "unknown run"})
            elif tail == "transcript":
                self._send_json(HTTPStatus.OK, build_run_state(run_dir))
            elif tail:
                self._send_json(HTTPStatus.NOT_FOUND, {"error": "unknown endpoint"})
            else:
                self._send_json(HTTPStatus.OK, _scan_payload(state, run_dir))

        def _handle_start(self) -> None:
            kwargs, error = _validate_scan_body(self._read_body())
            if error is not None or kwargs is None:
                self._send_json(HTTPStatus.BAD_REQUEST, {"error": error or "invalid"})
                return
            job = state.jobs.start_scan(**kwargs)
            self._send_json(HTTPStatus.ACCEPTED, {"job": job})

        def _handle_stop(self, path: str) -> None:
            name = path[len("/api/scans/") : -len("/stop")]
            job = state.jobs.stop(name)
            if job is None:
                self._send_json(HTTPStatus.NOT_FOUND, {"error": "unknown job"})
                return
            self._send_json(HTTPStatus.OK, {"job": job})

        def _handle_resume(self, path: str) -> None:
            name = path[len("/api/scans/") : -len("/resume")]
            if _run_dir(state, name) is None:
                self._send_json(HTTPStatus.NOT_FOUND, {"error": "unknown run"})
                return
            try:
                job = state.jobs.resume_scan(name)
            except ValueError:
                self._send_json(HTTPStatus.NOT_FOUND, {"error": "unknown run"})
                return
            self._send_json(HTTPStatus.ACCEPTED, {"job": job})

        def _handle_config(self) -> None:
            body = self._read_body()
            config: dict[str, Any] = {}
            model = str(body.get("model") or "").strip()
            api_base = str(body.get("api_base") or "").strip()
            backend = str(body.get("backend") or "auto")
            if backend not in _BACKENDS:
                self._send_json(HTTPStatus.BAD_REQUEST, {"error": "invalid_backend"})
                return
            if model:
                config["model"] = model
            if api_base:
                config["api_base"] = api_base
            config["backend"] = backend
            # Blank key = keep the saved one; the phone never re-sends what
            # it was never shown.
            api_key = str(body.get("api_key") or "")
            existing = load_mobile_config()
            if api_key:
                config["api_key"] = api_key
            elif existing.get("api_key"):
                config["api_key"] = existing["api_key"]
            save_mobile_config(config)
            self._send_json(HTTPStatus.OK, public_config())

        # -- static PWA --------------------------------------------------------

        def _handle_static(self, path: str, query: str) -> None:
            root = static_dir().resolve()
            rel = unquote(path).lstrip("/")
            target = (root / rel).resolve() if rel else root / "index.html"
            if (target != root and root not in target.parents) or not target.is_file():
                # SPA fallback: the app is a single page; unknown routes get it.
                target = root / "index.html"
            if not target.is_file():
                self._send_json(HTTPStatus.NOT_FOUND, {"error": "not found"})
                return
            content = target.read_bytes()
            content_type, _ = mimetypes.guess_type(str(target))
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", content_type or "application/octet-stream")
            self.send_header("Content-Length", str(len(content)))
            if target.name == "index.html":
                self.send_header("Cache-Control", "no-cache")
                token = (parse_qs(query).get("token") or [""])[0]
                if token and secrets.compare_digest(token, state.session_token):
                    self.send_header(
                        "Set-Cookie",
                        f"{state.cookie_name}={state.session_token}; Path=/; "
                        "HttpOnly; SameSite=Strict",
                    )
            elif target.name == "sw.js":
                self.send_header("Cache-Control", "no-cache")
            else:
                self.send_header("Cache-Control", "public, max-age=86400")
            self.end_headers()
            self.wfile.write(content)

    return MobileHandler


def authorized_url(base_url: str, token: str) -> str:
    return f"{base_url}/?{urlencode({'token': token})}"


def serve(
    *,
    host: str = "127.0.0.1",
    port: int = 7681,
    jobs: JobManager | None = None,
) -> tuple[ThreadingHTTPServer, str, str]:
    """Start the mobile server on a background thread.

    Returns (server, base_url, session_token). Callers own the lifetime.
    """
    state = _MobileState(jobs or JobManager())
    handler = _make_handler(state)
    try:
        httpd = ThreadingHTTPServer((host, port), handler)
    except OSError:
        if port == 0:
            raise
        logger.info("mobile port %s unavailable, falling back to ephemeral", port)
        httpd = ThreadingHTTPServer((host, 0), handler)
    httpd.daemon_threads = True
    bound_port = int(httpd.server_address[1])
    state.cookie_name = f"{SESSION_COOKIE_PREFIX}_{bound_port}"
    thread = threading.Thread(target=httpd.serve_forever, name="strix-mobile", daemon=True)
    thread.start()
    return httpd, f"http://{host}:{bound_port}", state.session_token


__all__ = ["authorized_url", "serve", "static_dir"]
