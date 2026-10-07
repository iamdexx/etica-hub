#!/bin/sh
set -eu
: "${MAIN_RPC:?MAIN_RPC is required}"
: "${DB_CLIENT_TYPE:=pg}"
export DB_CLIENT_TYPE
for i in $(seq 1 60); do
  node -e "require('./db/knex.js').raw('select 1').then(()=>process.exit(0)).catch(()=>process.exit(1))" && break
  echo "waiting for database ($i)"; sleep 2
done
npx knex migrate:latest
node seed.js
exec pm2-runtime ecosystem.config.js
