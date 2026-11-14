# 01 — Incident: something is wrong

Goal: find which layer is broken in five minutes, stop the damage, then pick the matching runbook.

## 1. Look from outside (30 seconds)
- `curl -s -o /dev/null -w '%{http_code}' https://<domain>/login` should be 200; `/api/v1/auth/me` should be 401. Anything else (000, 502, 503, 404 on `/login`) means the web or proxy layer is down: go to step 3.
- Open the web app. If the page loads but conversations do not move, the API or a queue is the problem: steps 3 and 4.

## 2. Is it the last release?
If the problem started right after a deploy, go straight to [02 Rollback](02-rollback.md) (a rollback is cheap and safe because migrations are additive). Look at the latest `CI` run on `feat/production-pilot` and the time of the first complaint.

## 3. Look at the host (SSM)
Run on the host: `cd /opt/tezda/deploy && dc ps` (all of api, web, postgres, redis, caddy should be `Up` and `healthy`), then `dc logs --since 15m api | tail -n 80`. Logs are JSON lines with `event` names and a correlation id (ADR 030); search for `"level":"error"` or `"event":"...failed"`. Never paste a whole log into a ticket: copy only the failing lines and remove customer text and tokens.
- A container restarting in a loop: read its last 50 log lines; a failed migration or a missing setting in `.env.production` prints a clear message.
- Disk full (`df -h /` above 90 percent): a full disk stopped a deploy once (2026-11-04). Old images are pruned by the deploy script; `docker system df` shows what uses space; dumps are in `/var/backups/tezda`.

## 4. Pick the runbook
| Symptom | Go to |
|---|---|
| Messages late or stuck, bot silent | [03 Queue backlog](03-queue-backlog.md) |
| Leads not reaching the CRM, "no data" answers | [04 Connector outage](04-connector-outage.md) |
| Bot answers fail, handovers jump, errors from the provider | [05 LLM outage](05-llm-outage.md) |
| Data missing or wrong | [06 Restore from backup](06-restore-from-backup.md) |
| A key or token is exposed | [07 Secret rotation](07-secret-rotation.md) |

## 5. Contain customer impact
- To make the bot stop answering while you investigate, set the channel's assistant to off in the web app (Settings, Bot: the mode switch; the effective mode shows `OFF` or `HOLD`). Customers then wait for a human, and operators still see every conversation in the Inbox.
- Do not restart the database container to "see if it helps": connections are pooled and the API reconnects on its own.

## 6. After
Write down: what was seen, when it started, what fixed it, and what would have caught it earlier. Add a line to `docs/DEFECTS.md` if it was a code defect. If a command in a runbook was wrong or missing, fix the runbook in the same change.
