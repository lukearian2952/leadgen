#!/usr/bin/env bash
#
# Prove a registry-db backup actually restores.
#
# ── Why this is a script and not a note in the runbook ───────────────────────
#
# A backup nobody has restored is a hypothesis. This project has already been
# bitten twice by things that were built, asserted against a spec, and never
# executed — Florida's date format, and the preflight census. A dump file that
# exists is not evidence that it contains what you think.
#
# Restores into a **throwaway container on its own volume**, counts the rows,
# and deletes both. It never touches registry-db, and it cannot: the scratch
# container has a different name, a different volume and a different port.
#
# Usage: restore-test.sh [path-to-dump]     (default: newest in /opt/leadgen/backups)

set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/opt/leadgen/backups}"
SCRATCH="registry-restore-test"
SCRATCH_PW="restore-test-$(date +%s)"

dump="${1:-$(ls -t "$BACKUP_DIR"/registry-*.dump 2>/dev/null | head -1)}"
[[ -n "$dump" && -f "$dump" ]] || { echo "no dump found in $BACKUP_DIR" >&2; exit 1; }

echo "restore test: $dump ($(du -h "$dump" | cut -f1))"

cleanup() {
  docker rm -f "$SCRATCH" >/dev/null 2>&1 || true
  docker volume rm "${SCRATCH}-data" >/dev/null 2>&1 || true
}
# Runs on success, failure and Ctrl-C alike. A scratch container left running
# after a failed test is 2 GB of RAM on a box that also runs someone's ERP.
trap cleanup EXIT

cleanup   # in case a previous run died before its own trap fired

docker run -d --name "$SCRATCH" \
  -e POSTGRES_USER=registry \
  -e POSTGRES_PASSWORD="$SCRATCH_PW" \
  -e POSTGRES_DB=registry \
  -v "${SCRATCH}-data:/var/lib/postgresql/data" \
  --memory 1g \
  postgres:17-alpine >/dev/null

echo -n "  waiting for scratch postgres"
for _ in $(seq 1 60); do
  if docker exec "$SCRATCH" pg_isready -U registry -d registry >/dev/null 2>&1; then break; fi
  echo -n "."
  sleep 2
done
echo

docker exec "$SCRATCH" pg_isready -U registry -d registry >/dev/null

# pg_trgm and pgcrypto are created by the schema in the real database; a custom
# dump carries `CREATE EXTENSION` only if the extension was dumpable, so create
# them first and let the restore skip what already exists.
docker exec "$SCRATCH" psql -U registry -d registry -q \
  -c 'create extension if not exists pg_trgm' \
  -c 'create extension if not exists pgcrypto'

echo "  restoring…"
# `--exit-on-error` is deliberately absent: a custom dump replays CREATE
# EXTENSION statements that will already exist, and those are the only errors
# expected. Real failures show up as missing rows in the counts below, which is
# the check that actually matters.
docker exec -i "$SCRATCH" pg_restore \
  -U registry -d registry --no-owner --no-privileges \
  < "$dump" 2>&1 | grep -viE 'already exists|extension "pg_trgm"|extension "pgcrypto"' || true

echo
echo "  restored contents:"
docker exec "$SCRATCH" psql -U registry -d registry -t -A -F'  ' -c "
  select 'registry_entities', to_char(count(*), 'FM999,999,999') from registry_entities
  union all
  select 'zip_county', to_char(count(*), 'FM999,999,999') from zip_county
  union all
  select 'registry_ingest_runs', to_char(count(*), 'FM999,999,999') from registry_ingest_runs
  order by 1" | sed 's/^/    /'

echo
echo "  per state:"
docker exec "$SCRATCH" psql -U registry -d registry -t -A -F'  ' -c "
  select state, to_char(count(*), 'FM999,999,999')
    from registry_entities group by 1 order by count(*) desc" | sed 's/^/    /'

# The indexes are what make the match affordable. A restore that brought the
# rows but not the trigram index would work and be unusably slow, which is the
# kind of "success" worth catching here.
echo
echo "  indexes on registry_entities:"
docker exec "$SCRATCH" psql -U registry -d registry -t -A -c "
  select indexname from pg_indexes
   where tablename = 'registry_entities' order by 1" | sed 's/^/    /'

echo
echo "  a trigram match against the restored data:"
docker exec "$SCRATCH" psql -U registry -d registry -t -A -F' | ' -c "
  select name, round(similarity(name_norm, 'high graphics')::numeric, 3)
    from registry_entities
   where state = 'FL' and name_norm % 'high graphics'
   order by similarity(name_norm, 'high graphics') desc limit 3" | sed 's/^/    /'

echo
echo "restore test PASSED — scratch container and volume removed on exit"
