#!/bin/sh
set -e
echo "[entrypoint] applying database migrations..."
npx prisma migrate deploy
if [ "${SEED_DEMO_DATA:-true}" = "true" ]; then
  echo "[entrypoint] seeding demo data (idempotent)..."
  node dist/seed/seed.js
fi
echo "[entrypoint] starting API"
exec node dist/server.js
