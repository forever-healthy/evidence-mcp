#!/usr/bin/env bash
# Bootstrap a venv on first run, then launch the TUI (ctl.py); `npm run tui` at the repo root is the shortcut.
set -euo pipefail
# The caller's working directory stays: ctl.py resolves .env and evidence/ from
# it, as the server does (issue #31). The venv and the script are addressed
# by absolute path instead.
HERE="$(cd "$(dirname "$0")" && pwd)"
VENV="$HERE/.venv"
PY="${PYTHON:-python3}"
# Rebuild the venv unless its python can actually import textual: a stub venv
# (no ensurepip) or one built by another OS on a shared checkout exists but
# does not work, so probe the import rather than the directory.
if ! "$VENV/bin/python" -c "import textual" >/dev/null 2>&1; then
  [ -d "$VENV" ] && find "$VENV" -mindepth 1 -delete 2>/dev/null || true
  if command -v uv >/dev/null 2>&1; then
    uv venv -q --python "$PY" "$VENV"
    uv pip install -q --python "$VENV/bin/python" -r "$HERE/requirements.txt"
  else
    "$PY" -m venv "$VENV"
    "$VENV/bin/pip" install -q --upgrade pip
    "$VENV/bin/pip" install -q -r "$HERE/requirements.txt"
  fi
fi
exec "$VENV/bin/python" "$HERE/ctl.py" "$@"
