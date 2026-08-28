#!/bin/bash
# Generate the Monday ops summary and file it under docs/REPORTS/weekly/.
#
# Two steps because of the container boundary: `run.sh` mounts only
# /opt/leadgen/scratch as writable (scripts run as uid 10001 and cannot write
# anywhere else — RUNBOOK trap 9), so the script writes there and this moves the
# result to the documented path as root.
#
# The report is read-only against every database it touches. Failing to move the
# file is not worth failing the run over, but it is worth saying so loudly:
# a weekly report nobody can find is a weekly report nobody reads.
set -uo pipefail

LEADGEN=/opt/leadgen
SCRATCH="$LEADGEN/scratch/weekly"
DEST="$LEADGEN/docs/REPORTS/weekly"

mkdir -p "$SCRATCH" "$DEST"
# Scripts run in the container as uid 10001. A scratch directory created here as
# root is not writable by them, and the script fails with EACCES *after* doing
# all its work — RUNBOOK trap 9, hit while writing this file.
chmod 1777 "$SCRATCH"

if ! "$LEADGEN/run.sh" scripts/weekly-report.ts; then
  echo "$(date -u +%FT%TZ) weekly-report FAILED" >&2
  exit 1
fi

# Newest report the container just wrote.
latest=$(ls -1t "$SCRATCH"/*.md 2>/dev/null | head -1)
if [ -z "${latest:-}" ]; then
  echo "$(date -u +%FT%TZ) weekly-report produced no file in $SCRATCH" >&2
  exit 1
fi

cp "$latest" "$DEST/$(basename "$latest")"
echo "$(date -u +%FT%TZ) weekly report at $DEST/$(basename "$latest")"

# Keep 26 weeks on the box; the repo copy is the archive.
ls -1t "$SCRATCH"/*.md 2>/dev/null | tail -n +27 | xargs -r rm --
