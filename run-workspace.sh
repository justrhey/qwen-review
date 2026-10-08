#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
node -e "require('typescript')" || { echo 'Install the parser with npm install in this folder.' >&2; exit 1; }
exec python3 workspace.py
