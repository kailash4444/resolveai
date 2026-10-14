#!/usr/bin/env bash
# macOS/Linux counterpart of start-livekit-local.ps1: run a local LiveKit server for browser voice calls.
# Credentials are generated once and kept outside the repository (owner-only file).
set -euo pipefail
cd "$(dirname "$0")"

PYTHON="${PYTHON:-.venv/bin/python}"
export RESOLVEAI_LOCAL_LIVEKIT_FILE="${RESOLVEAI_LOCAL_LIVEKIT_FILE:-$HOME/Library/Application Support/ResolveAI/livekit.json}"
RUNTIME="data/livekit-runtime"
BINARY="$RUNTIME/livekit-server"
VERSION="1.13.9"

prepared="$("$PYTHON" -m realapp.local_livekit)"
mode="$("$PYTHON" -c 'import json,sys; print(json.loads(sys.argv[1])["mode"])' "$prepared")"
if [ "$mode" = "external" ]; then echo "Using the configured LiveKit Cloud/external server."; exit 0; fi
config="$("$PYTHON" -c 'import json,sys; print(json.loads(sys.argv[1])["config_path"])' "$prepared")"
chmod 600 "$config" "$RESOLVEAI_LOCAL_LIVEKIT_FILE" 2>/dev/null || true

if lsof -nP -iTCP:7880 -sTCP:LISTEN >/dev/null 2>&1; then echo "A LiveKit server is already listening on port 7880."; exit 0; fi

mkdir -p "$RUNTIME"
if [ ! -x "$BINARY" ]; then
  # LiveKit ships macOS builds through Homebrew only. `brew fetch` downloads and checksum-verifies the
  # bottle without installing it system-wide; we keep just the server binary inside this project.
  command -v brew >/dev/null || { echo "Homebrew is required to download LiveKit on macOS (https://brew.sh)."; exit 1; }
  brew fetch --force-bottle livekit >/dev/null
  bottle="$(brew --cache --force-bottle livekit)"
  tmp="$(mktemp -d)"; tar -xzf "$bottle" -C "$tmp"
  cp "$(find "$tmp" -name livekit-server -type f | head -1)" "$BINARY"; chmod +x "$BINARY"; rm -rf "$tmp"
  "$BINARY" --version | grep -q "$VERSION" || echo "Note: LiveKit $("$BINARY" --version) differs from the tested $VERSION."
fi

nohup "$BINARY" --config "$config" > "$RUNTIME/server.log" 2> "$RUNTIME/server-error.log" &
echo $! > "$RUNTIME/server.pid"
for _ in $(seq 1 20); do
  if lsof -nP -iTCP:7880 -sTCP:LISTEN >/dev/null 2>&1; then echo "LiveKit is running locally on port 7880."; exit 0; fi
  sleep 0.5
  kill -0 "$(cat "$RUNTIME/server.pid")" 2>/dev/null || { echo "LiveKit stopped during startup. See $RUNTIME/server-error.log."; exit 1; }
done
echo "LiveKit did not become ready. See $RUNTIME/server-error.log."; exit 1
