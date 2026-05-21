#!/usr/bin/env bash
# PopChats — apply all SQL migrations to Supabase
#
# Usage:
#   1. Get your DB connection string from Supabase dashboard:
#      Project Settings → Database → Connection string → URI (use the "Session pooler" or "Direct connection")
#   2. Export it:
#        export SUPABASE_DB_URL='postgresql://postgres.PROJECTREF:PASSWORD@aws-0-REGION.pooler.supabase.com:5432/postgres'
#   3. Run:
#        ./migrate.sh
#
# Requires: psql (Postgres client). Install with:
#   - Termux:  pkg install postgresql
#   - macOS:   brew install libpq && brew link --force libpq
#   - Ubuntu:  sudo apt install postgresql-client

set -euo pipefail

if [[ -z "${SUPABASE_DB_URL:-}" ]]; then
  echo "ERROR: Set SUPABASE_DB_URL env var first."
  echo "  export SUPABASE_DB_URL='postgresql://postgres.xxx:PASSWORD@aws-0-REGION.pooler.supabase.com:5432/postgres'"
  exit 1
fi

if ! command -v psql >/dev/null 2>&1; then
  echo "ERROR: psql not found. Install postgresql client first."
  exit 1
fi

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

echo "== Applying migrations =="
for f in migrations/*.sql; do
  echo
  echo ">>> $f"
  psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f "$f"
done

echo
echo "All migrations applied successfully."
