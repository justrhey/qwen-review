#!/usr/bin/env bash
set -euo pipefail

cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
MODEL_FILE=models/Qwen_Qwen3.5-2B-Q4_K_M.gguf

if [[ ! -f "$MODEL_FILE" ]]; then
  aria2c --continue=true --max-connection-per-server=1 --split=1 \
    --min-split-size=16M --file-allocation=none --summary-interval=30 \
    --console-log-level=warn --download-result=hide --show-console-readout=false \
    --dir=models --out=Qwen_Qwen3.5-2B-Q4_K_M.gguf.part \
    'https://huggingface.co/bartowski/Qwen_Qwen3.5-2B-GGUF/resolve/7d26695454df6de5fbcce2e58681e62dae06ce43/Qwen_Qwen3.5-2B-Q4_K_M.gguf'
fi

python3 - <<'PY'
import hashlib
import json
from pathlib import Path

model = json.loads(Path('sources.json').read_text())['model']
final = Path('models') / model['file']
download = final if final.exists() else final.with_suffix('.gguf.part')
with download.open('rb') as stream:
    actual = hashlib.file_digest(stream, 'sha256').hexdigest()
if actual != model['sha256']:
    raise SystemExit('Model checksum mismatch; leaving the downloaded file for inspection.')
if download != final:
    download.rename(final)
print('Model SHA-256 verified. Ready to run.')
PY
