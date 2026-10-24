#!/usr/bin/env bash
# Development only. Starts the API (mock LLM unless overridden), the one-route
# proxy and a foreground cloudflared quick tunnel, registers the webhook, and
# on exit/Ctrl+C/error deletes the webhook and stops everything it started.
# The tunnel URL lives only in this shell. No secret is printed.
set -u
cd "$(dirname "$0")/.."
LOGDIR="${TMPDIR:-/tmp}/agentcore-telegram-session"
mkdir -p "$LOGDIR"
PIDS=()

cleanup() {
  trap - EXIT INT TERM
  echo "cleanup: deleting webhook, stopping processes"
  pnpm --silent telegram:live delete 2>&1 | grep -E "^deleteWebhook" || echo "deleteWebhook: NOT CONFIRMED - run: pnpm --filter @agentcore/api telegram:live delete"
  for pid in "${PIDS[@]:-}"; do [ -n "$pid" ] && kill "$pid" 2>/dev/null; done
  sleep 1
  for pid in "${PIDS[@]:-}"; do [ -n "$pid" ] && kill -9 "$pid" 2>/dev/null; done
  pgrep -fl cloudflared || echo "cloudflared: none running"
}
trap cleanup EXIT INT TERM

[ -f dist/main.js ] || { echo "build first: pnpm build"; exit 2; }
export LLM_PROVIDER="${LLM_PROVIDER:-mock}"
export LLM_TRUSTED_PROVIDERS="${LLM_TRUSTED_PROVIDERS:-mock}"
set -a; . ../../.env; set +a
[ -n "${TELEGRAM_CHANNEL_ACCOUNT_ID:-}" ] || { echo "Missing environment variable: TELEGRAM_CHANNEL_ACCOUNT_ID"; exit 2; }

node dist/main.js >"$LOGDIR/app.log" 2>&1 & PIDS+=($!)
pnpm --silent telegram:proxy >"$LOGDIR/proxy.log" 2>&1 & PIDS+=($!)
cloudflared tunnel --no-autoupdate --url http://127.0.0.1:4100 >"$LOGDIR/tunnel.log" 2>&1 & PIDS+=($!)

for _ in $(seq 1 45); do
  TELEGRAM_TEST_PUBLIC_URL=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$LOGDIR/tunnel.log" | head -1)
  [ -n "$TELEGRAM_TEST_PUBLIC_URL" ] && break; sleep 1
done
[ -n "${TELEGRAM_TEST_PUBLIC_URL:-}" ] || { echo "tunnel did not start"; exit 1; }
export TELEGRAM_TEST_PUBLIC_URL
pnpm --silent telegram:live register || exit 1
echo "READY. Logs: $LOGDIR (app.log has no token). Press Ctrl+C to stop."
wait
