#!/usr/bin/env bash
# Standalone launch: no Postgres, no Redis, no OPA required.
set -euo pipefail
cd "$(dirname "$0")"

command -v python3 >/dev/null || { echo "python3 is required"; exit 1; }
command -v npm     >/dev/null || { echo "npm is required"; exit 1; }

echo "==> backend dependencies"
python3 -m pip install -q -r backend/requirements.txt

echo "==> frontend dependencies"
[ -d web/node_modules ] || (cd web && npm install --no-audit --no-fund)

cleanup() { echo; echo "==> stopping"; kill 0 2>/dev/null || true; }
trap cleanup EXIT INT TERM

echo "==> api on :8000"
(cd backend && python3 -m uvicorn app.main:app --port 8000 --log-level warning) &

# Wait for the API rather than guessing, so the dashboard never loads first and
# shows its unreachable state for no reason.
for _ in $(seq 1 40); do
  curl -sf localhost:8000/health >/dev/null 2>&1 && break
  sleep 0.5
done
curl -sf localhost:8000/health >/dev/null 2>&1 \
  && echo "    ready: $(curl -s localhost:8000/health)" \
  || { echo "    api failed to start"; exit 1; }

echo "==> dashboard on :3000"
(cd web && npm run dev) &

echo
echo "  dashboard  http://localhost:3000"
echo "  api docs   http://localhost:8000/docs"
echo "  ctrl-c to stop both"
wait
