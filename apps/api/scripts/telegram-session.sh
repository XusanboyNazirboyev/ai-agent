#!/usr/bin/env bash
# Development only. Starts the API (bound to 127.0.0.1, mock LLM unless
# overridden), the one-route proxy and a foreground cloudflared quick tunnel,
# then registers the webhook. On exit, Ctrl+C, SIGTERM, SIGHUP or an error it
# attempts to delete the webhook and stops what it started. SIGKILL of this
# script cannot be handled. The tunnel URL lives only in this shell; no secret
# is printed.
set -u
cd "$(dirname "$0")/.."
# shellcheck source=telegram-session-lib.sh
. scripts/telegram-session-lib.sh
DELETE_WEBHOOK_CMD=(pnpm --silent telegram:live delete)
install_session_traps

LOGDIR="${TMPDIR:-/tmp}/agentcore-telegram-session"
mkdir -p "$LOGDIR"

[ -f dist/main.js ] || { echo "build first: pnpm build"; exit 2; }
set -a; . ../../.env; set +a
export LLM_PROVIDER=mock LLM_TRUSTED_PROVIDERS=mock API_HOST=127.0.0.1
[ -n "${TELEGRAM_CHANNEL_ACCOUNT_ID:-}" ] || { echo "Missing environment variable: TELEGRAM_CHANNEL_ACCOUNT_ID"; exit 2; }

node dist/main.js >"$LOGDIR/app.log" 2>&1 & register_pid $!
pnpm --silent telegram:proxy >"$LOGDIR/proxy.log" 2>&1 & register_pid $!
cloudflared tunnel --no-autoupdate --url http://127.0.0.1:4100 >"$LOGDIR/tunnel.log" 2>&1 & register_pid $!

for _ in $(seq 1 45); do
  TELEGRAM_TEST_PUBLIC_URL=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$LOGDIR/tunnel.log" | head -1)
  [ -n "$TELEGRAM_TEST_PUBLIC_URL" ] && break; sleep 1
done
[ -n "${TELEGRAM_TEST_PUBLIC_URL:-}" ] || { echo "tunnel did not start"; exit 1; }
export TELEGRAM_TEST_PUBLIC_URL
pnpm --silent telegram:live register || exit 1
echo "READY. Logs in $LOGDIR. Press Ctrl+C to stop."
wait
