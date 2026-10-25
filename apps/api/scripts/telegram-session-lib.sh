# Sourced by telegram-session.sh and by its test. Bash only.
# Cleanup is idempotent: the first call does the work, later calls are no-ops.
# It cannot run if the shell is killed with SIGKILL or the machine loses
# power; in that case run: pnpm --filter @agentcore/api telegram:live delete
PIDS=()
CLEANED=0

register_pid() { PIDS+=("$1"); }

# A killed child can linger as a zombie until its parent reaps it; that is dead.
alive() {
  local state
  state=$(ps -o stat= -p "$1" 2>/dev/null)
  [ -n "$state" ] && [ "${state#Z}" = "$state" ]
}

# Output lines are fixed strings so callers and tests can rely on them.
session_cleanup() {
  [ "$CLEANED" = 1 ] && return 0
  CLEANED=1
  echo "cleanup: deleting webhook, stopping processes"
  if "${DELETE_WEBHOOK_CMD[@]}" 2>&1 | grep -q "^deleteWebhook: ok=true"; then
    echo "cleanup: webhook deleted"
  else
    echo "cleanup: WEBHOOK DELETE NOT CONFIRMED - run: pnpm --filter @agentcore/api telegram:live delete"
  fi
  local pid
  for pid in ${PIDS[@]+"${PIDS[@]}"}; do kill "$pid" 2>/dev/null; done
  sleep 1
  for pid in ${PIDS[@]+"${PIDS[@]}"}; do
    if alive "$pid"; then
      kill -9 "$pid" 2>/dev/null
      echo "cleanup: process $pid needed SIGKILL"
    fi
  done
  for pid in ${PIDS[@]+"${PIDS[@]}"}; do
    sleep 0.2
    alive "$pid" && echo "cleanup: PROCESS $pid STILL RUNNING"
  done
  return 0
}

install_session_traps() {
  trap 'session_cleanup' EXIT
  trap 'session_cleanup; exit 130' INT
  trap 'session_cleanup; exit 143' TERM
  trap 'session_cleanup; exit 129' HUP
}
