#!/bin/bash
# AXOM_VID: local image-to-video on your Mac, without metered cloud GPU.
# Usage: bash local/start.command
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# Keep caches, tool binaries and temporary files inside this checkout.
# Clone AXOM_VID onto the SSD for these paths to reside on the external drive.
export XDG_CACHE_HOME="$ROOT/.cache"
export COREPACK_HOME="$ROOT/.corepack"
export npm_config_cache="$ROOT/.npm-cache"
export TMPDIR="$ROOT/.tmp/"
mkdir -p "$XDG_CACHE_HOME" "$COREPACK_HOME" "$npm_config_cache" "$TMPDIR" "$ROOT/.pnpm-store"

echo "AXOM_VID · Local Mac mode"
echo "No paid API keys or cloud-run allowances are used in local mode."
echo "Phosphene (free software) must already be running on 127.0.0.1:8198."
echo "Project folder: $ROOT"
echo "After Phosphene finishes, verify both engines using:"
echo "  python3 $ROOT/local/acceptance.py"
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

# Install a small ARM64 FFmpeg wheel only if no executable is available.
# The local tools environment and binaries stay in the repository on the SSD.
if test -z "${AXOM_FFMPEG:-}"; then
  if command -v ffmpeg >/dev/null 2>&1; then
    export AXOM_FFMPEG="$(command -v ffmpeg)"
  else
    TOOLS_VENV="$ROOT/.local-tools"
    if ! test -x "$TOOLS_VENV/bin/python"; then
      echo "Preparing local GIF converter on the project drive…"
      "$PYTHON" -m venv "$TOOLS_VENV" || true
    fi
    if test -x "$TOOLS_VENV/bin/python"; then
      if ! "$TOOLS_VENV/bin/python" -c 'import imageio_ffmpeg' >/dev/null 2>&1; then
        "$TOOLS_VENV/bin/python" -m pip install --no-cache-dir 'imageio-ffmpeg==0.7.0' \
          || echo "NOTICE: GIF converter could not be installed. MP4 generation still works."
      fi
      if "$TOOLS_VENV/bin/python" -c 'import imageio_ffmpeg' >/dev/null 2>&1; then
        export AXOM_FFMPEG="$("$TOOLS_VENV/bin/python" -c 'import imageio_ffmpeg; print(imageio_ffmpeg.get_ffmpeg_exe())')"
      fi
    fi
  fi
fi
if test -n "${AXOM_FFMPEG:-}"; then
  echo "GIF converter: $AXOM_FFMPEG"
else
  echo "GIF converter unavailable. You can still generate and download MP4s."
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
  run_pnpm install --frozen-lockfile --store-dir "$ROOT/.pnpm-store"
fi
echo "Building AXOM_VID website…"
run_pnpm build
cd "$ROOT"

echo ""
echo "Starting AXOM_VID on the first available local port from 8765 to 8775…"
echo "The server will print and open its actual URL. It will not stop other applications."
echo "To stop the AXOM_VID bridge, press Ctrl+C in this Terminal window."
exec "$PYTHON" local/bridge.py --open
