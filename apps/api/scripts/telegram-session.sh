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
export API_HOST=127.0.0.1
# TELEGRAM_SESSION_LLM=gemini (set in .env) is an explicit opt-in to a real model:
# the text of the test conversation then goes to Google. Gemini stays an UNTRUSTED
# provider here: only SHADOW on the test account (drafts are stored, nothing is
# sent to the customer). Use test messages only.
case "${TELEGRAM_SESSION_LLM:-mock}" in
  gemini)
    [ -n "${GEMINI_API_KEY:-}" ] || { echo "Missing environment variable: GEMINI_API_KEY"; exit 2; }
    export LLM_PROVIDER=openai-compatible LLM_TRUSTED_PROVIDERS=mock \
      LLM_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai \
      LLM_API_KEY="$GEMINI_API_KEY" LLM_MODEL_FAST=gemini-3.5-flash-lite \
      LLM_MODEL_STRONG=gemini-3.5-flash-lite LLM_PRICING_VERSION=routing-free-2026-10-23 \
      LLM_RATE_LIMIT_RPM=8
    echo "LLM: Gemini (untrusted provider, SHADOW only, test messages only)" ;;
  gemini-live)
    # The owner declared Gemini trusted for THIS test run only (test messages, test
    # bot, test group): LIVE may then send the model's replies to the customer chat.
    [ -n "${GEMINI_API_KEY:-}" ] || { echo "Missing environment variable: GEMINI_API_KEY"; exit 2; }
    export LLM_PROVIDER=openai-compatible LLM_TRUSTED_PROVIDERS=openai-compatible \
      LLM_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai \
      LLM_API_KEY="$GEMINI_API_KEY" LLM_MODEL_FAST=gemini-3.5-flash-lite \
      LLM_MODEL_STRONG=gemini-3.5-flash-lite LLM_PRICING_VERSION=routing-free-2026-10-23 \
      LLM_RATE_LIMIT_RPM=8
    echo "LLM: Gemini declared TRUSTED for this run (LIVE allowed; test messages only)" ;;
  *) export LLM_PROVIDER=mock LLM_TRUSTED_PROVIDERS=mock ;;
esac
[ -n "${TELEGRAM_CHANNEL_ACCOUNT_ID:-}" ] || { echo "Missing environment variable: TELEGRAM_CHANNEL_ACCOUNT_ID"; exit 2; }

node dist/main.js >"$LOGDIR/app.log" 2>&1 & register_pid $!
pnpm --silent telegram:proxy >"$LOGDIR/proxy.log" 2>&1 & register_pid $!
# TELEGRAM_TUNNEL=ngrok (+ NGROK_DOMAIN, the free static domain; the authtoken is in
# ngrok's own config, never here) gives a stable address. The default is a
# Cloudflare quick tunnel, which has no uptime guarantee.
if [ "${TELEGRAM_TUNNEL:-cloudflared}" = ngrok ]; then
  [ -n "${NGROK_DOMAIN:-}" ] || { echo "Missing environment variable: NGROK_DOMAIN"; exit 2; }
  ngrok http 4100 --url "https://${NGROK_DOMAIN}" --log stdout >"$LOGDIR/tunnel.log" 2>&1 & register_pid $!
  TELEGRAM_TEST_PUBLIC_URL="https://${NGROK_DOMAIN}"
  for _ in $(seq 1 30); do
    grep -q "started tunnel\|ERR_NGROK\|authentication failed" "$LOGDIR/tunnel.log" && break; sleep 1
  done
  grep -q "ERR_NGROK\|authentication failed" "$LOGDIR/tunnel.log" && { echo "ngrok did not start (see the tunnel log, not printed)"; exit 1; }
else
  cloudflared tunnel --no-autoupdate --protocol http2 --url http://127.0.0.1:4100 >"$LOGDIR/tunnel.log" 2>&1 & register_pid $!
  for _ in $(seq 1 45); do
    TELEGRAM_TEST_PUBLIC_URL=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$LOGDIR/tunnel.log" | head -1)
    [ -n "$TELEGRAM_TEST_PUBLIC_URL" ] && break; sleep 1
  done
fi
[ -n "${TELEGRAM_TEST_PUBLIC_URL:-}" ] || { echo "tunnel did not start"; exit 1; }
export TELEGRAM_TEST_PUBLIC_URL
# A fresh quick-tunnel hostname can take a few seconds to resolve for Telegram.
registered=0
for _ in $(seq 1 30); do
  if pnpm --silent telegram:live register; then registered=1; break; fi
  sleep 4
done
[ "$registered" = 1 ] || exit 1
echo "READY. Logs in $LOGDIR. Press Ctrl+C to stop."
wait
