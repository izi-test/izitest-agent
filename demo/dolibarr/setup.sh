#!/bin/bash
# Writes .env with secrets of this machine (the database, the admin of Dolibarr), once.
# Nobody needs to know them: Dolibarr opens as the admin without a login page.
set -euo pipefail
cd "$(dirname "$0")"
if [[ -f .env ]]; then
  echo ".env is already there: kept."
  exit 0
fi
secret() { openssl rand -hex 16; }
umask 077
cat > .env <<EOF
DOLIBARR_VERSION=23.0.4
DB_ROOT_PASSWORD=$(secret)
DB_PASSWORD=$(secret)
ADMIN_PASSWORD=$(secret)
INSTANCE_ID=$(secret)
EOF
echo ".env written. Now: docker compose up -d"
