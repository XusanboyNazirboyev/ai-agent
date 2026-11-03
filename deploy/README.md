# Deploy (pilot, ADR 035)

One host runs `api`, `web`, `redis` and `caddy` with Docker Compose; PostgreSQL is RDS.

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
