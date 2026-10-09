#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/desktop-app"
exec env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron . "$@"
