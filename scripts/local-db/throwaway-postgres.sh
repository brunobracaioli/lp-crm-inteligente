#!/usr/bin/env bash
# Throwaway local Postgres 18 for the integration suites on machines WITHOUT Docker (so no `supabase start`).
# Loopback only, trust auth, throwaway data directory, no secrets. See docs/how-to/run-integration-tests.md.
#
# Usage:
#   PGDATA_DIR=/tmp/lp-pg PGPORT=54731 scripts/local-db/throwaway-postgres.sh up      # initdb (once) + start
#   PGDATA_DIR=/tmp/lp-pg PGPORT=54731 scripts/local-db/throwaway-postgres.sh reset   # recreate DB + apply migrations
#   PGDATA_DIR=/tmp/lp-pg PGPORT=54731 scripts/local-db/throwaway-postgres.sh down    # stop
#
# pg_cron: this cluster has no real pg_cron. `up` points extension_control_path at
# scripts/local-db/pg_cron_stub, a fake extension named pg_cron, so the migrations run UNCHANGED
# (`CREATE EXTENSION pg_cron` + `cron.schedule`). The stub records jobs in cron.job and never runs them.
set -euo pipefail

: "${PGDATA_DIR:?set PGDATA_DIR to a throwaway directory (it is created on first use)}"
PGPORT="${PGPORT:-54731}"
PGBIN="${PGBIN:-/usr/lib/postgresql/18/bin}"
ROOT="$(git rev-parse --show-toplevel)"
APP_PASSWORD="lp_api_local_test"

psql_admin() {
  "$PGBIN/psql" -h 127.0.0.1 -p "$PGPORT" -U postgres -v ON_ERROR_STOP=1 -q "$@"
}

case "${1:-}" in
  up)
    if [[ ! -d "$PGDATA_DIR" ]]; then
      "$PGBIN/initdb" -D "$PGDATA_DIR" -U postgres --auth=trust >/dev/null
      echo "extension_control_path = '$ROOT/scripts/local-db/pg_cron_stub:\$system'" >>"$PGDATA_DIR/postgresql.conf"
    fi
    "$PGBIN/pg_ctl" -D "$PGDATA_DIR" -o "-p $PGPORT -k '' -c listen_addresses=127.0.0.1" \
      -l "$PGDATA_DIR/server.log" -w start >/dev/null
    for role in anon authenticated service_role; do
      psql_admin -d postgres -c "DO \$\$BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='$role') THEN CREATE ROLE $role NOLOGIN; END IF; END\$\$"
    done
    ;;
  reset)
    psql_admin -d template1 -c "DROP DATABASE IF EXISTS postgres WITH (FORCE)" -c "CREATE DATABASE postgres"
    for migration in "$ROOT"/supabase/migrations/*.sql; do
      psql_admin -d postgres -f "$migration"
    done
    psql_admin -d postgres -c "ALTER ROLE lp_api PASSWORD '$APP_PASSWORD'"
    ;;
  down)
    "$PGBIN/pg_ctl" -D "$PGDATA_DIR" -m fast stop
    ;;
  *)
    echo "usage: PGDATA_DIR=<dir> [PGPORT=54731] $0 up|reset|down" >&2
    exit 64
    ;;
esac
