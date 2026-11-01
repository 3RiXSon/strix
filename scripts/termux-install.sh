#!/data/data/com.termux/files/usr/bin/bash
# Install Strix Mobile on Android (Termux) — no Docker, no root.
#
# Why a special path: Android has no Docker daemon and Termux cannot create
# /workspace or load kernel modules, so the desktop install cannot work.
# This script installs the pure-Python agent, selects the `local` runtime
# backend (agent tools run directly in Termux), and leaves you one command
# (`strix mobile`) from scanning with your phone as the only machine.
set -euo pipefail

if [ -z "${TERMUX_VERSION:-}" ] && [[ "${PREFIX:-}" != *"com.termux"* ]]; then
  echo "This script is for Termux on Android. On desktop/server, use scripts/install.sh" >&2
  exit 1
fi

pkg update -y
# python/git/curl are required; the scanners are optional but are what make
# local mode useful — the agent uses whatever it finds (see the Device tab).
pkg install -y python git curl nmap openssl

python -m pip install --upgrade pip
python -m pip install strix-agent

mkdir -p "$HOME/.strix"
cat > "$HOME/.strix/mobile-env.sh" <<'EOF'
# Strix Mobile (Termux): local backend = tools run on-device, no Docker.
export STRIX_RUNTIME_BACKEND="${STRIX_RUNTIME_BACKEND:-local}"
# export STRIX_LLM="openai/gpt-5.4"   # or set model + key in the app Settings
# export LLM_API_KEY="<key>"
EOF

echo
echo "Installed. Next:"
echo "  source ~/.strix/mobile-env.sh"
echo "  strix mobile            # then open the printed link on this phone"
echo
echo "Optional scanners (install what you need): pkg install sqlmap ffuf"
