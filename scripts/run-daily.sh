#!/bin/bash
#
# Daily job-finder run, invoked by launchd.
#
# launchd does NOT read your shell profile: no .zshrc, no nvm, and a PATH of
# roughly /usr/bin:/bin:/usr/sbin:/sbin. Every binary therefore needs an
# absolute path, which is the whole reason this wrapper exists rather than
# launchd calling `pnpm` directly.

set -euo pipefail

# Derived from this script's own location, so the checkout can live anywhere.
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Where node and pnpm actually live. Override in the environment if your setup
# is unusual; otherwise the usual locations are probed, newest nvm first.
if [ -z "${NODE_BIN_DIR:-}" ]; then
  candidates=()
  # A pnpm already on PATH (true when this script is run by hand, not launchd).
  if command -v pnpm >/dev/null 2>&1; then
    candidates+=("$(dirname "$(command -v pnpm)")")
  fi
  # nvm installs, newest version first.
  while IFS= read -r dir; do
    [ -n "$dir" ] && candidates+=("$dir")
  done < <(ls -d "${NVM_DIR:-$HOME/.nvm}"/versions/node/*/bin 2>/dev/null | sort -rV)
  candidates+=("$HOME/.local/share/pnpm" /opt/homebrew/bin /usr/local/bin)

  for candidate in "${candidates[@]}"; do
    if [ -n "$candidate" ] && [ -x "$candidate/pnpm" ]; then
      NODE_BIN_DIR="$candidate"
      break
    fi
  done
fi

if [ -z "${NODE_BIN_DIR:-}" ] || [ ! -x "$NODE_BIN_DIR/pnpm" ]; then
  echo "ERROR: could not find pnpm. Set NODE_BIN_DIR to the directory containing it."
  echo "Hint: run \`dirname \$(command -v pnpm)\` in your normal shell."
  exit 1
fi

# Put node/pnpm on PATH, and keep the system paths for anything else.
export PATH="$NODE_BIN_DIR:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

cd "$PROJECT_DIR"

echo "=============================================================="
echo "Run started: $(date '+%Y-%m-%d %H:%M:%S %Z')"
echo "=============================================================="

# Ollama is a launchd service too, but the machine may have just woken and the
# daemon can lag behind. Wait for it rather than failing the whole run.
for attempt in $(seq 1 30); do
  if curl -sf -m 5 -o /dev/null http://localhost:11434/api/tags; then
    echo "Ollama is up (after ${attempt}s)."
    break
  fi
  if [ "$attempt" -eq 30 ]; then
    echo "ERROR: Ollama did not become reachable within 30s. Aborting this run."
    exit 1
  fi
  sleep 1
done

# `set -e` would abort here on a non-zero exit before the status could be
# logged, so failures are handled explicitly — a failed run must still say so
# in the log rather than ending it mid-sentence.
set +e
"$NODE_BIN_DIR/pnpm" jobs:run
status=$?
set -e

echo "Run finished: $(date '+%Y-%m-%d %H:%M:%S %Z') (exit ${status})"
echo
exit $status
