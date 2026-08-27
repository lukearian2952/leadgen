#!/usr/bin/env bash
#
# Nightly pg_dump of registry-db.
#
# ── Why this exists ──────────────────────────────────────────────────────────
#
# registry-db lives in a Docker volume. That survives `docker compose up -d`,
# a rebuild and a reboot — but not `docker compose down -v`, and not the disk.
# The data is rebuildable from the adapters, and `registry_ingest_runs` records
# the scope each state was loaded under so a rebuild does not have to guess,
# but Florida alone is a 1.8 GB download and roughly fifteen minutes of parsing.
# A dump is seconds and a few hundred MB.
#
# ── Format ───────────────────────────────────────────────────────────────────
#
# `--format=custom` (`-Fc`), which is compressed and restorable table-by-table
# with `pg_restore`. A plain SQL dump of 300k rows with jsonb columns is large
# and can only be replayed whole.
#
# `--no-owner --no-privileges`: the restore target is a scratch container whose
# role names will not match. Without these, every statement fails on a missing
# role and the restore looks broken when it is not.
#
# Run from cron; see infra/registry-db/backup.cron.

set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/opt/leadgen/backups}"
KEEP="${KEEP:-7}"
CONTAINER="${CONTAINER:-leadgen-registry-db-1}"
DB_USER="${REGISTRY_DB_USER:-registry}"
DB_NAME="${REGISTRY_DB_NAME:-registry}"

mkdir -p "$BACKUP_DIR"

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
target="$BACKUP_DIR/registry-$stamp.dump"

# Refuse rather than write a truncated dump next to six good ones. 2 GB of
# headroom against a dump measured in hundreds of MB.
avail_kb="$(df -Pk "$BACKUP_DIR" | awk 'NR==2 {print $4}')"
if [[ "$avail_kb" -lt 2097152 ]]; then
  echo "registry backup: only $((avail_kb / 1024)) MB free in $BACKUP_DIR — refusing" >&2
  exit 1
fi

if ! docker exec "$CONTAINER" pg_isready -U "$DB_USER" -d "$DB_NAME" >/dev/null 2>&1; then
  echo "registry backup: $CONTAINER is not accepting connections" >&2
  exit 1
fi

# Written to a .partial first and renamed on success, so a dump interrupted
# half-way never occupies a slot in the retention window — the failure mode
# that turns "seven backups" into "six backups and a corrupt file".
docker exec "$CONTAINER" pg_dump \
  -U "$DB_USER" -d "$DB_NAME" \
  --format=custom --no-owner --no-privileges \
  > "$target.partial"

# A custom-format dump always starts with the magic string "PGDMP". Checking it
# costs nothing and catches the case where pg_dump wrote an error to stdout.
if ! head -c 5 "$target.partial" | grep -q 'PGDMP'; then
  rm -f "$target.partial"
  echo "registry backup: output is not a pg_dump archive — discarded" >&2
  exit 1
fi

mv "$target.partial" "$target"
size="$(du -h "$target" | cut -f1)"

# Retention. `ls -t` newest-first, keep $KEEP, delete the rest. Only files
# matching our own naming, so nothing else in the directory is at risk.
pruned=0
while IFS= read -r old; do
  rm -f "$old"
  pruned=$((pruned + 1))
done < <(ls -t "$BACKUP_DIR"/registry-*.dump 2>/dev/null | tail -n "+$((KEEP + 1))")

echo "registry backup: $target ($size), pruned $pruned, keeping $KEEP"
