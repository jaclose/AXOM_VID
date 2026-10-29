#!/bin/bash
# AXOM_VID: local image-to-video on your Mac, without metered cloud GPU.
# Usage: bash local/start.command
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "AXOM_VID · Local Mac mode"
echo "No paid API keys or cloud-run allowances are used in local mode."
echo "Phosphene (free software) must already be running on 127.0.0.1:8198."
echo ""

run_pnpm() {
  if command -v pnpm >/dev/null 2>&1; then
    pnpm "$@"
  elif command -v corepack >/dev/null 2>&1; then
    corepack pnpm "$@"
  else
    echo "ERROR: pnpm is required. Install Node.js and enable pnpm, then run again."
    exit 1
  fi
}

PYTHON=""
for candidate in python3.12 python3.11 python3.10 python3; do
  if command -v "$candidate" >/dev/null 2>&1; then
    if "$candidate" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)' 2>/dev/null; then
      PYTHON="$candidate"
      break
    fi
  fi
done
if test -z "$PYTHON"; then
  echo "ERROR: Python 3.10 or newer is required. No Python packages are needed."
  exit 1
fi

if ! curl -sf --max-time 2 http://127.0.0.1:8198/status >/dev/null 2>&1; then
  echo "NOTICE: Phosphene isn't running."
  echo "Open Pinokio -> Phosphene -> Start, then click Check local engine."
  echo "The AXOM_VID studio will open without it."
  echo ""
fi

cd "$ROOT/web"
if ! test -d node_modules; then
  echo "First-run frontend dependencies missing; installing only website packages."
  run_pnpm install --frozen-lockfile
fi
echo "Building AXOM_VID website…"
run_pnpm build
cd "$ROOT"

echo ""
echo "Opening http://127.0.0.1:8765/AXOM_VID/"
echo "To stop the bridge, press Ctrl+C in this Terminal window."
exec "$PYTHON" local/bridge.py --open
