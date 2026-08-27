#!/usr/bin/env bash
#
# Render searxng/settings.yml from settings.template.yml.
#
# SearXNG's engine requests do not go through ProxyPool — it makes its own
# outbound calls — so the proxy has to be configured inside its own settings
# file, which means the Decodo password ends up in that file. The template is
# what is tracked; the rendered file is gitignored.
#
# Idempotent. Run after any edit to the template, and after any Decodo
# credential change, then restart the container:
#
#   ./infra/render-searxng-settings.sh && docker compose up -d --force-recreate searxng
#
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
template="$here/searxng/settings.template.yml"
output="$here/searxng/settings.yml"
envfile="${ENV_FILE:-$here/.env}"

[[ -f "$template" ]] || { echo "missing template: $template" >&2; exit 1; }

if [[ -f "$envfile" ]]; then
  # `set -a` exports everything the file defines. Values containing shell
  # metacharacters must be double-quoted in .env or sourcing aborts partway —
  # see docs/HANDOFF.md §4.
  set -a
  # shellcheck disable=SC1090
  . "$envfile"
  set +a
fi

for var in DECODO_USERNAME DECODO_PASSWORD DECODO_HOST DECODO_PORT; do
  if [[ -z "${!var:-}" ]]; then
    echo "$var is not set — cannot render the SearXNG proxy config." >&2
    echo "Without it SearXNG egresses from this host's own IP, which is how" >&2
    echo "four of five engines ended up captcha'd." >&2
    exit 1
  fi
done

# The rotating endpoint: a different exit IP per request, which is what a
# search engine's rate limiter is counting.
proxy="http://${DECODO_USERNAME}:${DECODO_PASSWORD}@${DECODO_HOST}:${DECODO_PORT}"

# `|` as the sed delimiter because the URL contains `/`. The password could in
# principle contain `|`, so the substitution is done in awk on a literal string
# instead of a regex.
PROXY="$proxy" awk '
  {
    if (index($0, "__SEARXNG_OUTGOING_PROXY__") > 0) {
      before = substr($0, 1, index($0, "__SEARXNG_OUTGOING_PROXY__") - 1)
      print before ENVIRON["PROXY"]
    } else print
  }
' "$template" > "$output.tmp"

if grep -q '__SEARXNG_OUTGOING_PROXY__' "$output.tmp"; then
  rm -f "$output.tmp"
  echo "placeholder survived substitution — refusing to write" >&2
  exit 1
fi

mv "$output.tmp" "$output"
chmod 600 "$output"

echo "rendered $output"
echo "  proxy host: ${DECODO_HOST}:${DECODO_PORT} (password redacted)"
echo "  restart with: docker compose up -d --force-recreate searxng"
