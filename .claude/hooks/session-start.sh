#!/bin/bash
# SessionStart hook: install Node dependencies so tests run in web sessions.
# Synchronous (no async flag) so deps are guaranteed ready before the session starts.
set -euo pipefail

# Only needed in the ephemeral remote (Claude Code on the web) container.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "$CLAUDE_PROJECT_DIR"

# npm install (not ci) so the cached container layer is reused on later runs.
npm install --no-audit --no-fund
