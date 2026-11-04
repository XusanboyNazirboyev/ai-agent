#!/bin/sh
# Sets up or updates the staging host (ADR 035 amendments 1-2) and starts the
# stack. Run as root on the instance; running it again keeps .env.production
# and only moves to the given image tag.
#   sh bootstrap-staging.sh <domain> <image tag>
# Secrets are generated here with openssl and never printed. The LLM provider
# stays at the API default until real keys are added to .env.production.
set -eu

domain="${1:?usage: bootstrap-staging.sh <domain> <image tag>}"
tag="${2:?usage: bootstrap-staging.sh <domain> <image tag>}"
repo_url=https://github.com/XusanboyNazirboyev/ai-agent.git
branch="${TEZDA_BRANCH:-feat/production-pilot}"
dir=/opt/tezda

command -v git >/dev/null || apt-get install -y -q git
if [ ! -d "$dir/.git" ]; then
  git clone --quiet --depth 1 --branch "$branch" --filter=blob:none --sparse \
    "$repo_url" "$dir"
  git -C "$dir" sparse-checkout set deploy
else
  git -C "$dir" fetch --quiet --depth 1 origin "$branch"
  git -C "$dir" checkout --quiet --force FETCH_HEAD
fi
cd "$dir/deploy"

umask 077
previous=''
if [ ! -f .env.production ]; then
  cat > .env.production <<EOF
NODE_ENV=production
SESSION_COOKIE_SECURE=true
TEZDA_DOMAIN=$domain
WEB_ORIGINS=https://$domain
PUBLIC_BASE_URL=https://$domain
WEB_PROXY_SECRET=$(openssl rand -hex 32)
SECRETS_MASTER_KEY=$(openssl rand -base64 32)
POSTGRES_HOST=postgres
POSTGRES_PORT=5432
POSTGRES_DATABASE=tezda
POSTGRES_USER=tezda
POSTGRES_PASSWORD=$(openssl rand -hex 24)
POSTGRES_SSL_MODE=disable
IMAGE_REPO=ghcr.io/xusanboynazirboyev/tezda
TAG=$tag
EOF
  echo "created $dir/deploy/.env.production (secrets generated on this host)"
else
  previous="$(sed -n 's/^TAG=//p' .env.production)"
  sed -i "s/^TAG=.*/TAG=$tag/" .env.production
  echo "kept $dir/deploy/.env.production, TAG=$tag"
fi

dc() {
  docker compose --env-file .env.production \
    -f docker-compose.prod.yml -f docker-compose.local-db.yml "$@"
}
dc pull --quiet
dc up -d --wait postgres redis
dc run --rm migrate
dc up -d --wait

# The disk holds about two releases: keep this tag and the one before it
# (rollback); a migrate image is needed only while migrating. Every tag can be
# pulled again from ghcr.io. (A full disk stopped a deploy on 2026-11-04.)
docker images --format '{{.Repository}}:{{.Tag}}' | grep '/tezda-' |
  while read -r image; do
    old="${image##*:}"
    case "$image" in
      */tezda-migrate:*) ;;
      *) if [ "$old" = "$tag" ] || [ "$old" = "$previous" ]; then continue; fi ;;
    esac
    docker rmi "$image" >/dev/null 2>&1 || true
  done
docker image prune -f >/dev/null

printf '%s\n' \
  "30 2 * * * root BACKUP_KEEP_DAYS=7 $dir/deploy/backup-postgres.sh >> /var/log/tezda-backup.log 2>&1" \
  > /etc/cron.d/tezda-backup
chmod 644 /etc/cron.d/tezda-backup

dc ps --format 'table {{.Service}}\t{{.Status}}'
df -h / | awk 'NR == 2 { print "disk: " $3 " used of " $2 " (" $5 ")" }'
echo "open https://$domain"
