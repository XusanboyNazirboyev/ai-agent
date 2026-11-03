#!/bin/sh
# Dumps the on-host staging database (ADR 035 amendment 2) and keeps
# BACKUP_KEEP_DAYS days of dumps. Run from cron as root, e.g. daily:
#   BACKUP_KEEP_DAYS=<days> /opt/tezda/deploy/backup-postgres.sh
# The dumps stay on the instance's disk; copying them off the host is still open.
set -eu

keep_days="${BACKUP_KEEP_DAYS:?set BACKUP_KEEP_DAYS (ADR 035, open question P5)}"
backup_dir="${BACKUP_DIR:-/var/backups/tezda}"

cd "$(dirname "$0")"
umask 077
mkdir -p "$backup_dir"

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
target="$backup_dir/tezda-$stamp.dump"

# Custom format (restore with pg_restore); written to .partial first so an
# interrupted dump is never mistaken for a good one.
docker compose --env-file .env.production \
  -f docker-compose.prod.yml -f docker-compose.local-db.yml \
  exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' \
  > "$target.partial"
mv "$target.partial" "$target"

find "$backup_dir" -name 'tezda-*.dump' -type f -mtime +"$keep_days" -delete
find "$backup_dir" -name 'tezda-*.dump.partial' -type f -mtime +1 -delete
echo "backup written: $target"
