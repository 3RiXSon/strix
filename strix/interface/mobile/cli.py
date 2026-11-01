"""`strix mobile` command: serve the phone control plane."""

from __future__ import annotations

import argparse
import logging
import time

from rich.console import Console

from strix.interface.mobile.server import authorized_url, serve
from strix.runtime.backends import resolve_backend_name
from strix.runtime.capabilities import detect_capabilities


logger = logging.getLogger(__name__)


def run_mobile(argv: list[str]) -> None:
    parser = argparse.ArgumentParser(
        prog="strix mobile",
        description=(
            "Serve Strix Mobile: an installable phone web app to launch and "
            "watch scans. Run it on the phone itself (Termux/Android, local "
            "backend) or on any host the phone can reach (desktop/VPS, for iOS)."
        ),
    )
    parser.add_argument("--port", type=int, default=7681, help="Port (default 7681).")
    parser.add_argument(
        "--host",
        default="127.0.0.1",
        help="Bind address. Use 0.0.0.0 to reach this server from a phone on "
        "the same network / mesh VPN (the printed link carries the auth token).",
    )
    args = parser.parse_args(argv)

    console = Console()
    caps = detect_capabilities()
    backend = resolve_backend_name(str(caps.get("backend_configured") or "auto"))

    httpd, url, token = serve(host=args.host, port=args.port)
    open_url = authorized_url(url, token)

    console.print()
    console.print("[bold white]STRIX MOBILE[/]")
    console.print(f"  Backend   [cyan]{backend}[/]  (configured: {caps['backend_configured']})")
    console.print(
        f"  Docker    [{'green' if caps['docker']['daemon'] else 'yellow'}]"
        f"{'daemon up' if caps['docker']['daemon'] else 'not available — local mode'}[/]"
    )
    llm_label = caps["llm"]["model"] or "[yellow]not configured (set it in the app)[/]"
    console.print(f"  LLM       {llm_label}")
    console.print()
    console.print("Open on your phone (authorizes that browser):")
    console.print(f"  [#60a5fa]{open_url}[/]", soft_wrap=True)
    if args.host not in ("127.0.0.1", "localhost"):
        console.print(
            "[yellow]Bound beyond localhost:[/] anyone with this link can start "
            "scans on this machine. Prefer a mesh VPN (e.g. Tailscale) over "
            "port-forwarding, and stop the server when done."
        )
    console.print("[dim]Add to Home Screen in the phone browser to install. Ctrl-C stops.[/]")
    console.print()

    try:
        while True:
            time.sleep(1.0)
    except KeyboardInterrupt:
        console.print("\n[dim]Strix Mobile stopped.[/]")
    finally:
        httpd.shutdown()
        httpd.server_close()


__all__ = ["run_mobile"]
