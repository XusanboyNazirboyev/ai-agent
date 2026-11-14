# 06 — Restore the database from a backup

Backups: `deploy/backup-postgres.sh` runs from `/etc/cron.d/tezda-backup` every day at 02:30 UTC, writes a custom-format `pg_dump` to `/var/backups/tezda/tezda-<UTC stamp>.dump` and keeps `BACKUP_KEEP_DAYS` (7) days. A dump is also taken by hand before risky releases (`cd /opt/tezda/deploy && BACKUP_KEEP_DAYS=7 sh backup-postgres.sh`).

**Limit that matters:** the dumps are on the same disk as the database, so they do not survive losing the instance. Off-host encrypted backups (roadmap P0.1) are deferred by the owner until real customer data exists; this runbook becomes the recovery path only after that is done. Until then, losing the instance means losing the data (staging holds demo data only).

## Rules
Restoring replaces data. It needs the owner's explicit permission for the exact target database, and the first run is always into a NEW scratch database, never over the live one. No `DROP`, `TRUNCATE` or reset of the live database without that permission.

## A. Prove a dump is good (do this first; this is the restore drill)
On the host:
1. `ls -lt /var/backups/tezda | head` and pick the newest `.dump` (a `.partial` file is an interrupted dump: ignore it).
2. Create a scratch database: `dc exec -T postgres sh -c 'createdb -U "$POSTGRES_USER" tezda_restore_check'`
3. Restore into it: `dc exec -T postgres sh -c 'pg_restore -U "$POSTGRES_USER" -d tezda_restore_check --no-owner' < /var/backups/tezda/<file>.dump` (the dump file is read from the host and sent in; warnings about extensions or owners are expected, errors about missing tables are not).
4. Check: `dc exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d tezda_restore_check -tAc "select count(*) from tenants; select count(*) from leads; select migration_name from _prisma_migrations order by finished_at desc limit 1"'`. Counts should be in line with the live database and the last migration name should match the deployed release.
5. Drop only the scratch database when you are done (it is yours, not live data): `dc exec -T postgres sh -c 'dropdb -U "$POSTGRES_USER" tezda_restore_check'`.
Record the date, the dump name, its size and how long the restore took in this file under "Drill log".

## B. Recover the live database (owner permission required)
1. Tell the owner what is lost, the newest good dump (its timestamp is the recovery point: everything after it is gone) and what you will overwrite. Wait for the written go-ahead.
2. Take a fresh dump of the current state first (even if damaged): `sh backup-postgres.sh`.
3. Stop writers: `dc stop api web` (Redis and Caddy may stay up).
4. Restore into a scratch database as in A, verify it, then swap: rename the live database away (`ALTER DATABASE ... RENAME`) and the restored one into its place, instead of dropping anything. Keep the renamed original until the owner agrees to delete it.
5. `dc up -d --wait`, then check `/login`, sign in, open Inbox and Leads.
6. Queue state lives in Redis and is not part of the dump: customer messages that were processed after the recovery point are gone from the database but may still be in Redis or redelivered by Telegram. Check duplicates in the Inbox.

## Drill log
| Date | Dump | Size | Restore time | Result |
|---|---|---|---|---|
| 2026-11-14 | `tezda-20261114T023001Z.dump` (the nightly cron dump of 02:30 UTC) | 724 KB | 3 s into scratch database `tezda_restore_check` | Good: 1 tenant and 5 leads, same as the live database; the last migration in the dump is `20261123090000_tenant_connector_roles` (taken before the later `lead_archive` release, as expected). Proves the dump restores and that the nightly cron works. The scratch database was left in place: dropping it needs the owner's go-ahead. Not yet drilled: recovery of the live database (part B), loss of the instance. |

## Known limits
Part A (a dump restores into a scratch database) was run on 2026-11-14, part B was not. Secrets stored in the database are encrypted with `SECRETS_MASTER_KEY` from `.env.production`: a restored database is unreadable for channel tokens without the same key (back the key up separately, see 07). RDS point-in-time recovery will replace this when the database moves to RDS.
