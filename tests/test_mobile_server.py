"""Tests for the Strix Mobile PWA server (`strix mobile`)."""

from __future__ import annotations

import json
import sys
import time
import urllib.error
import urllib.request
from typing import TYPE_CHECKING, Any

import pytest

from strix.interface.mobile import jobs as jobs_module
from strix.interface.mobile.jobs import JobManager
from strix.interface.mobile.server import serve


if TYPE_CHECKING:
    from collections.abc import Iterator
    from http.server import ThreadingHTTPServer
    from pathlib import Path


class _Client:
    def __init__(self, base: str) -> None:
        self.base = base
        self.cookie = ""

    def request(
        self, path: str, *, method: str = "GET", body: dict[str, Any] | None = None
    ) -> tuple[int, dict[str, str], Any]:
        data = json.dumps(body).encode() if body is not None else None
        headers = {"Content-Type": "application/json"}
        if self.cookie:
            headers["Cookie"] = self.cookie
        req = urllib.request.Request(self.base + path, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                raw = resp.read().decode()
                return resp.status, dict(resp.headers), _maybe_json(raw)
        except urllib.error.HTTPError as exc:
            raw = exc.read().decode()
            return exc.code, dict(exc.headers), _maybe_json(raw)

    def authorize(self, token: str) -> None:
        status, headers, _ = self.request(f"/?token={token}")
        assert status == 200
        self.cookie = headers["Set-Cookie"].split(";")[0]


def _maybe_json(raw: str) -> Any:
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return raw


@pytest.fixture
def mobile(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> Iterator[tuple[_Client, ThreadingHTTPServer, JobManager]]:
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(jobs_module, "STATE_PATH", tmp_path / "jobs.json")
    monkeypatch.setattr(jobs_module, "LOG_DIR", tmp_path / "logs")
    monkeypatch.setattr(jobs_module, "CONFIG_PATH", tmp_path / "config.json")
    manager = JobManager(base_dir=tmp_path / "strix_runs")
    httpd, url, _token = serve(host="127.0.0.1", port=0, jobs=manager)
    client = _Client(url)
    client.authorize(_token)
    yield client, httpd, manager
    httpd.shutdown()
    httpd.server_close()


def test_api_requires_session(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.chdir(tmp_path)
    httpd, url, token = serve(host="127.0.0.1", port=0)
    try:
        anon = _Client(url)
        status, _, _ = anon.request("/api/status")
        assert status == 403
        status, _, _ = anon.request("/api/scans", method="POST", body={"targets": ["x"]})
        assert status == 403
        # The PWA shell itself is public; only token bearers get the cookie.
        status, headers, _ = anon.request("/")
        assert status == 200
        assert "Set-Cookie" not in headers
        status, headers, _ = anon.request(f"/?token={token}")
        assert "Set-Cookie" in headers
    finally:
        httpd.shutdown()
        httpd.server_close()


def test_pwa_assets_and_manifest(mobile: tuple[_Client, Any, Any]) -> None:
    client, _, _ = mobile
    for path in ("/app.js", "/style.css", "/sw.js", "/icon.svg"):
        status, _, _ = client.request(path)
        assert status == 200, path
    status, _, manifest = client.request("/manifest.webmanifest")
    assert status == 200
    assert manifest["display"] == "standalone"
    assert manifest["short_name"] == "Strix"


def test_status_and_config_roundtrip(mobile: tuple[_Client, Any, Any]) -> None:
    client, _, _ = mobile
    status, _, caps = client.request("/api/status")
    assert status == 200
    assert caps["backend_resolved"] in ("docker", "local")
    assert "tools" in caps

    status, _, cfg = client.request(
        "/api/config",
        method="POST",
        body={"model": "openai/gpt-5.4", "api_key": "sk-test-secret", "backend": "local"},
    )
    assert status == 200
    assert cfg["model"] == "openai/gpt-5.4"
    assert cfg["backend"] == "local"
    assert cfg["api_key_set"] is True
    assert "api_base" in cfg
    # The key is write-only: it must never come back over the API.
    assert "sk-test-secret" not in json.dumps(cfg)
    _, _, cfg2 = client.request("/api/config")
    assert cfg2["api_key_set"] is True


def test_scan_validation(mobile: tuple[_Client, Any, Any]) -> None:
    client, _, _ = mobile
    for body, code in [
        ({"targets": []}, "invalid_target"),
        ({"targets": ["https://example.com"], "scan_mode": "warp"}, "invalid_scan_mode"),
        ({"targets": ["https://example.com"], "max_budget_usd": -1}, "invalid_budget"),
        ({"targets": ["https://example.com"], "instructions": "x" * 5000}, "invalid_instructions"),
    ]:
        status, _, payload = client.request("/api/scans", method="POST", body=body)
        assert status == 400, body
        assert payload["error"] == code


def test_job_lifecycle_stop_and_log(
    mobile: tuple[_Client, Any, Any], monkeypatch: pytest.MonkeyPatch
) -> None:
    client, _, _manager = mobile
    monkeypatch.setattr(
        jobs_module,
        "_scan_command",
        lambda **_kw: [
            sys.executable,
            "-c",
            "import time; print('alive', flush=True); time.sleep(60)",
        ],
    )
    status, _, payload = client.request(
        "/api/scans",
        method="POST",
        body={"targets": ["https://example.com"], "scan_mode": "quick"},
    )
    assert status == 202
    job = payload["job"]
    assert job["status"] in ("starting", "running")

    for _ in range(50):
        _, _, log = client.request(f"/api/scans/{job['id']}/log")
        if "alive" in log.get("log", ""):
            break
        time.sleep(0.1)

    status, _, payload = client.request(f"/api/scans/{job['id']}/stop", method="POST", body={})
    assert status == 200
    assert payload["job"]["status"] == "stopped"


def test_scan_detail_for_finished_run(mobile: tuple[_Client, Any, Any], tmp_path: Path) -> None:
    client, _, _ = mobile
    run_dir = tmp_path / "strix_runs" / "demo-run"
    run_dir.mkdir(parents=True)
    (run_dir / "run.json").write_text(
        json.dumps(
            {
                "run_name": "demo-run",
                "status": "completed",
                "scan_mode": "quick",
                "start_time": "2026-01-01T00:00:00Z",
                "end_time": "2026-01-01T00:10:00Z",
                "targets_info": [{"original": "https://example.com"}],
            }
        ),
        encoding="utf-8",
    )
    (run_dir / "vulnerabilities.json").write_text(
        json.dumps([{"title": "XSS", "severity": "high", "target": "https://example.com"}]),
        encoding="utf-8",
    )
    (run_dir / "penetration_test_report.md").write_text("# Report\n", encoding="utf-8")

    status, _, payload = client.request("/api/scans/demo-run")
    assert status == 200
    assert payload["severity_counts"]["high"] == 1
    assert payload["vulnerabilities"][0]["title"] == "XSS"
    assert payload["report_markdown"].startswith("# Report")

    status, _, _ = client.request("/api/scans/../secret")
    assert status in (403, 404)
    status, _, _ = client.request("/api/scans/nope")
    assert status == 404
