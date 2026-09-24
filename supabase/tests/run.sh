#!/usr/bin/env bash
# Apply the migrations to a scratch database and check the RLS policies.
# Usage: PGHOST=... PGPORT=... PGUSER=postgres supabase/tests/run.sh
set -euo pipefail
export PGOPTIONS="-c client_min_messages=warning"
cd "$(dirname "$0")"
DB="bee2bee_rls_test_$$"
psql -v ON_ERROR_STOP=1 -q -d postgres -c "create database $DB"
trap 'psql -q -d postgres -c "drop database if exists $DB" >/dev/null' EXIT
run() { psql -v ON_ERROR_STOP=1 -q -X -d "$DB" "$@"; }
run -f 00_supabase_stub.sql
run -f 01_legacy_schema.sql
for m in ../migrations/*.sql; do run -f "$m"; done
# Idempotency: applying twice must succeed.
for m in ../migrations/*.sql; do run -f "$m"; done
run -f 90_rls_assertions.sql
