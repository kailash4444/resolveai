#!/usr/bin/env bash
# macOS counterpart of run-local-real.ps1: start local LiveKit, then ResolveAI on http://127.0.0.1:8080.
# Extra arguments go to uvicorn, e.g. ./run-local-mac.sh --reload
set -euo pipefail
cd "$(dirname "$0")"
# Keep locally saved credentials outside the repository (on macOS ~/ResolveAI is this repo: paths are case-insensitive).
export RESOLVEAI_LOCAL_LIVEKIT_FILE="${RESOLVEAI_LOCAL_LIVEKIT_FILE:-$HOME/Library/Application Support/ResolveAI/livekit.json}"
export RESOLVEAI_LOCAL_GEMINI_FILE="${RESOLVEAI_LOCAL_GEMINI_FILE:-$HOME/Library/Application Support/ResolveAI/gemini_api_key}"
export RESOLVEAI_LOCAL_KEY_FILE="${RESOLVEAI_LOCAL_KEY_FILE:-$HOME/Library/Application Support/ResolveAI/openai_api_key}"
./start-livekit-local.sh
exec .venv/bin/python -m uvicorn realapp.main:app --host 127.0.0.1 --port 8080 "$@"
