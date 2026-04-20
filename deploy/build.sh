#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# Load env vars
if [ -f .env ]; then
  set -a; source .env; set +a
fi

echo "=== Step 1: Build server bundle ==="
bun build server.ts --target=bun --outfile=deploy/e2b/server.js
cp workspace_tool.py deploy/e2b/workspace_tool.py
echo "Server bundle: $(du -h deploy/e2b/server.js | cut -f1)"

echo ""
echo "=== Step 2: Build frontend ==="
VITE_BASE="/editor/" bun run build
rm -rf deploy/worker/public
mkdir -p deploy/worker/public/editor
cp -r dist/* deploy/worker/public/editor/
echo "Frontend copied to deploy/worker/public/editor/"

echo ""
echo "=== Step 3: Build E2B template ==="
cd deploy/e2b
e2b template build
cd "$ROOT"
echo "E2B template built."

echo ""
echo "=== Step 4: Deploy Worker ==="
cd deploy/worker
bun install --frozen-lockfile 2>/dev/null || bun install
wrangler deploy
cd "$ROOT"

echo ""
echo "=== Done! ==="
echo ""
echo "If this is the first deploy, set secrets:"
echo "  cd deploy/worker"
echo "  wrangler secret put E2B_API_KEY"
echo "  wrangler secret put ANTHROPIC_API_KEY"
