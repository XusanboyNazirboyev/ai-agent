# Deploy (pilot, ADR 035)

One host runs `api`, `web`, `redis` and `caddy` with Docker Compose; PostgreSQL is RDS,
or, for staging, a `postgres` container on the same host (`docker-compose.local-db.yml`,
ADR 035 amendment 2).

1. Build images: `docker build -f Dockerfile.production --target api|web|migrate .`
   (`--build-arg API_URL=...` only if the API is not reachable as `http://api:4000`).
2. On the host, render `deploy/.env.production` (see `env.production.example`) from SSM
   and export `WEB_PROXY_SECRET`, `TEZDA_DOMAIN`, `IMAGE_REPO` and `TAG`.
3. Migrate, then start:
   `docker compose -f deploy/docker-compose.prod.yml run --rm migrate`
   `docker compose -f deploy/docker-compose.prod.yml up -d`
4. Roll back by starting the previous `TAG`; migrations are additive, nothing is dropped.

Caddy obtains the TLS certificate for `TEZDA_DOMAIN` (ports 80 and 443 must reach the host).
Only `/webhooks/*` reaches the API directly; `/health` and `/probe` are not public.

## Staging with PostgreSQL on the host
Run every command from `deploy/` with both files; `--env-file` also supplies the values
the compose files interpolate (`WEB_PROXY_SECRET`, `TEZDA_DOMAIN`, `POSTGRES_*`):

    alias dc='docker compose --env-file .env.production -f docker-compose.prod.yml -f docker-compose.local-db.yml'
    dc run --rm migrate
    dc up -d

Backups: `backup-postgres.sh` writes a `pg_dump` (custom format) to `/var/backups/tezda`
and deletes dumps older than `BACKUP_KEEP_DAYS` (required; 7 for staging, ADR 035). Run it daily from
root's crontab. Restore: `pg_restore -d <database> <file>`. The dumps stay on the
instance's disk, so they do not survive losing the instance; an off-host copy is still open.
Moving to RDS later: dump, restore into RDS, point `POSTGRES_*` at RDS, drop the second file.
