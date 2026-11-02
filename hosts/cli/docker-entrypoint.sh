#!/bin/sh
# Starts the image's host: `ph run $PH_HOST $PH_VERB` (serve by default).
set -eu

# The switchboard takes its database from PH_SWITCHBOARD_DATABASE_URL (or
# PH_REACTOR_DATABASE_URL + DATABASE_URL). Without one it would quietly run
# on PGlite under /data: refuse, unless that is what is wanted.
if [ -z "${PH_SWITCHBOARD_DATABASE_URL:-}" ] \
  && [ -z "${PH_REACTOR_DATABASE_URL:-}" ] \
  && [ "${PH_ALLOW_PGLITE:-0}" != "1" ]; then
  echo "[entrypoint] PH_SWITCHBOARD_DATABASE_URL is not set (postgres://user:password@host:5432/db)." >&2
  echo "[entrypoint] Set it, or PH_ALLOW_PGLITE=1 to keep the stores in PGlite under ${PH_USER_DATA_DIR:-/data}." >&2
  exit 64
fi

# Secrets the instance keeps for itself when none is set (an explicit value
# wins): generated on first start next to its data (PH_USER_DATA_DIR is the
# kept volume) and never regenerated. The switchboard refuses a different
# workflows key later, and signed attachment links must stay valid.
#   PH_WORKFLOWS_SECRETS_MASTER_KEY  workflow connections' secrets (OAuth tokens)
#   PH_ATTACHMENT_URL_SIGNING_SECRET attachment download links
kept_secret() {
  name="$1"
  eval "current=\${$name:-}"
  [ -n "$current" ] && return 0
  file="${PH_USER_DATA_DIR:-/data}/$2"
  if [ ! -s "$file" ]; then
    (umask 077 && node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))' > "$file")
    echo "[entrypoint] generated $name in $file" >&2
  fi
  eval "$name=\$(cat \"\$file\")"
  export "$name"
}
kept_secret PH_WORKFLOWS_SECRETS_MASTER_KEY workflows-master-key
kept_secret PH_ATTACHMENT_URL_SIGNING_SECRET attachment-url-signing-secret

# The OpenRouter key a Vetra environment comes with (Vetra's LLM broker sets
# OPENROUTER_API_KEY, capped at the plan's budget): handed to the switchboard
# as its demo key (powerhouse.config.json ai.demoKeyFile), so the Assistant's
# setup card offers "Use the key included with your Sektar". An admin's click
# stores it like a typed key. Rewritten on every start, and removed when the
# environment has none, so a revoked key is not offered again.
# - Only for `serve`: a desktop build from this image would bundle the file
#   into its installer (bundle-stack.ts copies ai.demoKeyFile).
# - Never fatal: on a read-only /app the Assistant just offers no key.
# - Unset afterwards: nothing else in this host reads it, so the key lives in
#   the file (mode 600) and, once used, the switchboard's store only.
included_key="/app/.ph/included-openrouter-key"
if [ -n "${OPENROUTER_API_KEY:-}" ] && [ "${PH_VERB:-serve}" = "serve" ]; then
  if ! { mkdir -p "$(dirname "$included_key")" \
      && (umask 077 && printf '%s' "$OPENROUTER_API_KEY" > "$included_key"); } 2>/dev/null; then
    echo "[entrypoint] could not write $included_key: the Assistant will not offer the included OpenRouter key" >&2
  fi
else
  rm -f "$included_key" 2>/dev/null || true
fi
unset OPENROUTER_API_KEY

# Run records (pids) on the kept volume are from a container that is gone: in
# a fresh container nothing of this host runs yet, and a stale record makes
# `ph run` refuse to start ("already running") after every restart.
rm -rf "${PH_USER_DATA_DIR:-/data}/.ph/run"

exec node_modules/.bin/ph-cli run "${PH_HOST:-cli}" "${PH_VERB:-serve}"
