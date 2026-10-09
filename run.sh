#!/usr/bin/env bash
set -euo pipefail

QWEN_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

exec "$QWEN_DIR/runtime/vulkan/llama-b10809/llama-server" \
  --model "$QWEN_DIR/models/Qwen_Qwen3.5-2B-Q4_K_M.gguf" \
  --alias qwen-local \
  --host 127.0.0.1 \
  --port 8080 \
  --cors-origins localhost \
  --offline \
  --device Vulkan0 \
  --gpu-layers 99 \
  --threads 4 \
  --threads-batch 4 \
  --ctx-size 8192 \
  --parallel 1 \
  --batch-size 512 \
  --ubatch-size 128 \
  --cache-ram 256 \
  --n-predict 1024 \
  --jinja \
  --reasoning off \
  --temp 0.7 \
  --top-p 0.8 \
  --top-k 20 \
  --min-p 0 \
  --presence-penalty 1.5 \
  "$@"
