#!/bin/bash
# Run a workers script inside the registry-worker image, on the compose network.
#
# Deployed to /opt/leadgen/run.sh. It lived only on the server until 2026-08-28,
# which meant the one file every measurement is invoked through was the one file
# not under version control.
#
# /opt/leadgen/scratch is mounted writable so a script's output survives --rm.
# Scripts run as uid 10001, so any other output path fails EACCES after doing
# all the work.
#
# ── Why the environment is an explicit list ─────────────────────────────────
#
# Not `--env-file ./.env`: docker does not strip quotes the way the shell does,
# and three of these passwords are double-quoted because they contain shell
# metacharacters — they would arrive with the quotes embedded. Passing named
# variables through the shell that already parsed them is the only form that
# survives both.
#
# Scripts should read `process.env` directly rather than calling `loadConfig()`,
# which validates the whole worker environment and refuses to start without
# variables a measurement never touches.

cd /opt/leadgen && set -a && . ./.env && set +a
mkdir -p /opt/leadgen/scratch
exec docker run --rm --network leadgen_default \
  -v /opt/leadgen/workers/scripts:/app/scripts:ro \
  -v /opt/leadgen/workers/src:/app/src:ro \
  -v /opt/leadgen/scratch:/scratch \
  -e DATABASE_URL="$DATABASE_URL" \
  -e REGISTRY_DATABASE_URL="postgres://registry:${REGISTRY_DB_PASSWORD}@registry-db:5432/registry" \
  -e HUNTER_API_KEY="$HUNTER_API_KEY" \
  -e MAILBOX_PROVIDER="$MAILBOX_PROVIDER" \
  -e VERIFALIA_USERNAME="$VERIFALIA_USERNAME" \
  -e VERIFALIA_PASSWORD="$VERIFALIA_PASSWORD" \
  -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  -e SEARXNG_URL="${SEARXNG_URL:-http://searxng:8080}" \
  -e SERPER_API_KEY="$SERPER_API_KEY" \
  -e SOCRATA_APP_TOKEN="$SOCRATA_APP_TOKEN" \
  leadgen-registry-worker node_modules/.bin/tsx "$@"
