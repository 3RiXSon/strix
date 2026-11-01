"""Detached scan jobs for Strix Mobile.

A phone browser is an unreliable supervisor: iOS/Android kill background
tabs, suspend timers, and drop connections. So a mobile-launched scan never
belongs to the HTTP request that started it — it is a detached OS process
(``start_new_session``) whose only link back is this registry. The registry
is persisted to ``~/.strix/mobile-jobs.json`` so a server restart can still
show, stop, and resume scans it did not start in this process.

The scan CLI generates its own run name, so a fresh job starts nameless:
the manager records the run-directory set at launch and claims the first
new run directory that appears. Until then the job is ``starting``.
"""

from __future__ import annotations

import contextlib
import json
import logging
import os
import signal
import subprocess
import sys
import threading
import time
import uuid
from pathlib import Path
from typing import Any

from strix.config import load_settings
from strix.core.paths import run_record_path, runs_base_dir
from strix.utils.secret_files import write_secret_text


logger = logging.getLogger(__name__)

STATE_PATH = Path.home() / ".strix" / "mobile-jobs.json"
LOG_DIR = Path.home() / ".strix" / "mobile-logs"
CONFIG_PATH = Path.home() / ".strix" / "mobile-config.json"

# Headless exit-code contract (see AGENTS.md): 0 clean, 2 vulns, 1 fatal.
_EXIT_STATUS = {0: "completed", 2: "completed", 1: "failed"}

_ACTIVE = {"starting", "running"}


def load_mobile_config() -> dict[str, Any]:
    """Operator config saved from the phone (model/key/backend)."""
    try:
        data = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return data if isinstance(data, dict) else {}


def save_mobile_config(config: dict[str, Any]) -> None:
    """Persist mobile config with 0600 perms — it may hold an API key."""
    write_secret_text(CONFIG_PATH, json.dumps(config))


def public_config() -> dict[str, Any]:
    """Config as the phone may see it: never the API key itself."""
    config = load_mobile_config()
    settings = load_settings()
    return {
        "model": config.get("model") or settings.llm.model or "",
        "api_base": config.get("api_base") or settings.llm.api_base or "",
        "backend": config.get("backend") or "auto",
        "api_key_set": bool(config.get("api_key") or settings.llm.api_key),
    }


def _pid_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except (ProcessLookupError, PermissionError, OSError):
        return False
    return True


class JobManager:
    """Owns the mobile-launched scan processes and their registry file."""

    def __init__(self, *, base_dir: Path | None = None) -> None:
        self._base_dir = base_dir or runs_base_dir()
        self._lock = threading.Lock()
        self._procs: dict[str, subprocess.Popen[bytes]] = {}
        self._jobs: dict[str, dict[str, Any]] = self._load()

    # -- persistence ------------------------------------------------------

    def _load(self) -> dict[str, dict[str, Any]]:
        try:
            data = json.loads(STATE_PATH.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return {}
        if not isinstance(data, dict):
            return {}
        jobs: dict[str, dict[str, Any]] = {}
        for job_id, job in data.items():
            if isinstance(job, dict):
                jobs[str(job_id)] = job
        return jobs

    def _save(self) -> None:
        with contextlib.suppress(OSError):
            STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
            STATE_PATH.write_text(json.dumps(self._jobs, indent=1), encoding="utf-8")

    # -- lifecycle ----------------------------------------------------------

    def start_scan(
        self,
        *,
        targets: list[str],
        scan_mode: str,
        instructions: str | None = None,
        max_budget_usd: float | None = None,
    ) -> dict[str, Any]:
        """Launch a detached headless scan; return its job record."""
        return self._spawn(
            kind="scan",
            targets=targets,
            scan_mode=scan_mode,
            instructions=instructions,
            max_budget_usd=max_budget_usd,
            resume=None,
        )

    def resume_scan(self, run_name: str) -> dict[str, Any]:
        """Launch a detached ``--resume`` for an existing run."""
        run_dir = self._base_dir / run_name
        if run_dir.parent != self._base_dir or not run_record_path(run_dir).is_file():
            raise ValueError(f"unknown run: {run_name}")
        return self._spawn(
            kind="resume",
            targets=[],
            scan_mode="deep",
            instructions=None,
            max_budget_usd=None,
            resume=run_name,
        )

    def _spawn(
        self,
        *,
        kind: str,
        targets: list[str],
        scan_mode: str,
        instructions: str | None,
        max_budget_usd: float | None,
        resume: str | None,
    ) -> dict[str, Any]:
        job_id = uuid.uuid4().hex[:12]
        LOG_DIR.mkdir(parents=True, exist_ok=True)
        log_path = LOG_DIR / f"{job_id}.log"

        config = load_mobile_config()
        env = dict(os.environ)
        if config.get("model"):
            env["STRIX_LLM"] = str(config["model"])
        if config.get("api_key"):
            env["LLM_API_KEY"] = str(config["api_key"])
        if config.get("api_base"):
            env["LLM_API_BASE"] = str(config["api_base"])
        # Mobile defaults to auto: Docker where a daemon exists, local on a
        # phone. An explicit operator choice (settings screen or the server
        # process env) always wins over this default.
        env.setdefault("STRIX_RUNTIME_BACKEND", str(config.get("backend") or "auto"))
        env["PYTHONUNBUFFERED"] = "1"

        command = _scan_command(
            targets=targets,
            scan_mode=scan_mode,
            instructions=instructions,
            max_budget_usd=max_budget_usd,
            resume=resume,
        )
        known_runs = self._run_names()
        with log_path.open("ab") as log_handle:
            proc = subprocess.Popen(  # noqa: S603  # argv list only; never a shell string
                command,
                stdout=log_handle,
                stderr=subprocess.STDOUT,
                stdin=subprocess.DEVNULL,
                cwd=self._base_dir.parent,
                env=env,
                start_new_session=True,
            )
        job: dict[str, Any] = {
            "id": job_id,
            "kind": kind,
            "pid": proc.pid,
            "targets": targets,
            "scan_mode": scan_mode,
            "run_name": resume,
            "status": "starting" if resume is None else "running",
            "exit_code": None,
            "created_at": time.time(),
            "log": str(log_path),
            "_known_runs": sorted(known_runs),
            "_base_dir": str(self._base_dir),
        }
        with self._lock:
            self._procs[job_id] = proc
            self._jobs[job_id] = job
            self._save()
        logger.info("mobile scan job %s started (pid=%s)", job_id, proc.pid)
        return self._public(job)

    def stop(self, identifier: str) -> dict[str, Any] | None:
        """Terminate a job's whole process group (agent + tool children)."""
        job = self._find(identifier)
        if job is None:
            return None
        pid = int(job.get("pid") or 0)
        if _pid_alive(pid):
            with contextlib.suppress(ProcessLookupError, PermissionError, OSError):
                os.killpg(pid, signal.SIGTERM)
            deadline = time.monotonic() + 5
            while _pid_alive(pid) and time.monotonic() < deadline:
                time.sleep(0.1)
            if _pid_alive(pid):
                with contextlib.suppress(ProcessLookupError, PermissionError, OSError):
                    os.killpg(pid, signal.SIGKILL)
        job["status"] = "stopped"
        with self._lock:
            self._save()
        return self._public(job)

    # -- queries ------------------------------------------------------------

    def list_jobs(self) -> list[dict[str, Any]]:
        with self._lock:
            for job in self._jobs.values():
                self._refresh(job)
            jobs = list(self._jobs.values())
        return [
            self._public(job)
            for job in sorted(jobs, key=lambda j: -float(j.get("created_at") or 0))
        ]

    def get(self, identifier: str) -> dict[str, Any] | None:
        job = self._find(identifier)
        return self._public(job) if job is not None else None

    def log_tail(self, identifier: str, *, max_bytes: int = 32_768) -> str:
        job = self._find(identifier)
        if job is None:
            return ""
        try:
            raw = Path(str(job.get("log") or "")).read_bytes()
        except OSError:
            return ""
        return raw[-max_bytes:].decode("utf-8", errors="replace")

    # -- internals ----------------------------------------------------------

    def _find(self, identifier: str) -> dict[str, Any] | None:
        with self._lock:
            job = self._jobs.get(identifier)
            if job is not None:
                self._refresh(job)
                return job
            for candidate in self._jobs.values():
                if candidate.get("run_name") == identifier:
                    self._refresh(candidate)
                    return candidate
        return None

    def _refresh(self, job: dict[str, Any]) -> None:
        """Reconcile a job with reality: process exit + run-name discovery."""
        pid = int(job.get("pid") or 0)
        proc = self._procs.get(str(job.get("id")))
        exit_code = proc.poll() if proc is not None else None
        if exit_code is None and job.get("status") in _ACTIVE and not _pid_alive(pid):
            # Server restarted under a live scan, or the process died
            # without us reaping it: trust the pid, not our handle.
            exit_code = -1 if proc is None else None
        if job.get("run_name") is None:
            # Only claim runs from the directory this job was launched
            # against — a persisted job must not adopt an unrelated run
            # after the server restarts from a different working directory.
            if job.get("_base_dir") not in (None, str(self._base_dir)):
                return
            known = set(job.get("_known_runs") or [])
            new_runs = self._run_names() - known
            if new_runs:
                # Oldest unclaimed new run belongs to the oldest nameless job;
                # single-scan-at-a-time is the phone norm, so first match wins.
                job["run_name"] = min(
                    new_runs,
                    key=lambda name: run_record_path(self._base_dir / name).stat().st_mtime,
                )
        if exit_code is not None and job.get("status") in _ACTIVE:
            job["exit_code"] = exit_code
            job["status"] = _EXIT_STATUS.get(exit_code, "failed" if exit_code else "completed")
            if exit_code == -1:
                job["status"] = "failed"
            self._save()
        elif job.get("status") == "starting" and job.get("run_name"):
            job["status"] = "running"
            self._save()

    def _run_names(self) -> set[str]:
        if not self._base_dir.is_dir():
            return set()
        return {
            child.name for child in self._base_dir.iterdir() if run_record_path(child).is_file()
        }

    @staticmethod
    def _public(job: dict[str, Any]) -> dict[str, Any]:
        return {key: value for key, value in job.items() if not key.startswith("_")}


def _scan_command(
    *,
    targets: list[str],
    scan_mode: str,
    instructions: str | None,
    max_budget_usd: float | None,
    resume: str | None,
) -> list[str]:
    """Argv for the detached scan. List form only — never a shell string,
    so a target typed on a phone can never become shell syntax."""
    if getattr(sys, "frozen", False):
        base = [sys.executable]
    else:
        base = [sys.executable, "-m", "strix.interface.main"]
    command = [*base, "-n", "--scan-mode", scan_mode]
    if resume:
        command += ["--resume", resume]
    else:
        for target in targets:
            command += ["-t", target]
    if instructions:
        command += ["--instruction", instructions]
    if max_budget_usd is not None:
        command += ["--max-budget", str(max_budget_usd)]
    return command


__all__ = [
    "CONFIG_PATH",
    "JobManager",
    "load_mobile_config",
    "public_config",
    "save_mobile_config",
]
