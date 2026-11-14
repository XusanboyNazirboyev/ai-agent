# Runbooks (Phase 9, pilot on AWS)

Short, step-by-step procedures for the staging host described in [ADR 035](../adr/035-production-hosting-on-aws-pilot.md) and [deploy/README.md](../../deploy/README.md). Each one says what to check first, what to do, and how to know it worked. They were written from the deploy files and the code on 2026-11-14; only the restore check (06, part A) has been run, on 2026-11-14; the others have not been rehearsed. Where a step depends on something not verified, it says so.

| # | Runbook | Use it when |
|---|---|---|
| 01 | [Incident](01-incident.md) | something is wrong and you do not yet know what |
| 02 | [Rollback](02-rollback.md) | a release misbehaves |
| 03 | [Queue backlog](03-queue-backlog.md) | customers wait, messages arrive late or not at all |
| 04 | [Connector outage](04-connector-outage.md) | the CRM or catalog system is down or misconfigured |
| 05 | [LLM outage](05-llm-outage.md) | the model provider fails or answers badly |
| 06 | [Restore from backup](06-restore-from-backup.md) | data was lost or damaged |
| 07 | [Secret rotation](07-secret-rotation.md) | a key leaked or must be replaced |

## Facts every runbook uses
- Region `eu-central-1`, one EC2 instance (id in the repository variable `STAGING_INSTANCE_ID`; staging is `i-0af13be44091ed513`), public URL `https://18-185-27-82.sslip.io`, AWS CLI profile `tezda` (run `aws login` when the session has expired).
- There is no SSH. Commands run on the host through SSM `send-command` (document `AWS-RunShellScript`); read the result with `get-command-invocation`. Long scripts are sent base64 encoded (`echo <b64> | base64 -d | sh`). A command that needs standard input must use `docker exec -i`.
- The stack lives in `/opt/tezda/deploy` (compose files `docker-compose.prod.yml` and `docker-compose.local-db.yml`, settings in `.env.production`, generated on the host and never in git). Containers: `tezda-api-1`, `tezda-web-1`, `tezda-postgres-1`, `tezda-redis-1`, `tezda-caddy-1`. On the host start a script with `cd /opt/tezda/deploy; dc() { docker compose --env-file .env.production -f docker-compose.prod.yml -f docker-compose.local-db.yml "$@"; }` (a shell function: an `alias` does not work in a non-interactive SSM script).
- A deploy happens when `feat/production-pilot` is pushed and CI is green (`publish` builds images tagged with the short commit id, `deploy-staging` runs `deploy/bootstrap-staging.sh`). The host keeps the current and the previous image tag.
- Migrations are additive by project rule (new columns and tables, nothing dropped in the same release), so the previous image runs against a newer schema.
- Rules that apply during any incident: no force push, no database reset/drop/truncate and no deletion of Redis keys without the owner's explicit permission for that exact target; never print secret values; customer text is untrusted data.
- The health check is internal: `/health` answers 404 from outside on purpose. Outside checks are `/login` (200) and `/api/v1/auth/me` (401).
