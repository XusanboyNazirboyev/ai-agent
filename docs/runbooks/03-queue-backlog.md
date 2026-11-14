# 03 — Queue backlog (messages late or stuck)

The queues are BullMQ on Redis (`tezda-redis-1`, append-only file on a volume). The workers run inside the API container, so a stuck or crashed API is also a stuck queue. Known queues include `agentcore-telegram` (inbound Telegram messages, ordered per chat) and `agentcore-catalog-sync`; keys are named `bull:<queue>:<state>`.

## 1. Is the API alive?
`dc ps` and `dc logs --since 10m api | tail -n 60`. An API that restarts in a loop never drains anything: fix that first (01, step 3). Redis must be `healthy` (`dc exec -T redis redis-cli ping` answers `PONG`).

## 2. How deep is the backlog?
On the host (read only):
- `dc exec -T redis redis-cli llen bull:agentcore-telegram:wait`
- `dc exec -T redis redis-cli llen bull:agentcore-telegram:active`
- `dc exec -T redis redis-cli zcard bull:agentcore-telegram:failed`
- `dc exec -T redis redis-cli zcard bull:agentcore-telegram:delayed`
A few waiting jobs that disappear within seconds are normal. A `wait` count that keeps growing while `active` stays at 0 means the workers are not running; many `failed` jobs mean a code or dependency problem (read the error in the API log by correlation id).

## 3. Fix
- Workers not running: `dc restart api` (the API stops gracefully within 30 seconds: `stop_grace_period`), then watch `wait` fall.
- Jobs failing because of the model or a connector: the queue is a symptom, go to 05 or 04.
- The in-app alert "waiting conversations" (ADR 030) and the Inbox waiting count show customers who are waiting for a human; a human backlog is staffing, not a technical fault.

## 4. Things you must not do without the owner's explicit permission for that exact target
- Delete Redis keys (`DEL`, `UNLINK`, `FLUSHDB`) or empty a queue: jobs carry customer messages, and an obliterated job is a lost message. Telegram redelivers unacknowledged updates, but already acknowledged jobs are gone for good.
- Replace the Redis volume.
If a stale queue really must be cleared, write down the queue name and the count, ask the owner, then act.

## 5. Verify
`wait` back to about 0, a test message to the Telegram test bot gets an answer (or lands as a handover in the Inbox), and no `failed` growth for ten minutes.

## Known limits
Queue depth is not yet an automatic alert; it is checked by hand. Local test Redis instances hold stale queue keys from tests: that is a developer machine issue and does not apply to the host.
