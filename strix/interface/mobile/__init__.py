"""Strix Mobile — phone-first control plane for Strix scans.

Two obstacles keep the desktop build off a phone, and this package is the
workaround for both:

1. The scan engine normally needs Docker + a Kali sandbox image. The
   ``local`` runtime backend (``strix.runtime.local_backend``) runs agent
   tools directly on the host instead, which is what makes an Android /
   Termux install possible at all. ``STRIX_RUNTIME_BACKEND=auto`` (the
   mobile default) picks Docker when a daemon answers and ``local``
   otherwise.
2. The interactive UI is a terminal TUI. ``strix mobile`` instead serves an
   installable PWA: the phone is the controller (start, watch, stop,
   resume, read findings), the scan runs as a detached subprocess that
   survives the browser being closed or the phone sleeping, and the same
   server can run on a desktop/VPS for iOS, where no on-device scan is
   possible — the phone then remote-controls that host over the LAN or a
   mesh VPN such as Tailscale.
"""
