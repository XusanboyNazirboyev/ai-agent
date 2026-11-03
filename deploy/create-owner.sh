#!/bin/sh
# Creates a tenant and its first OWNER web login on the staging host
# (ADR 035). Run as root; the arguments go to the API's create-tenant-owner
# command, except --password-file, which this script sets:
#   sh /opt/tezda/deploy/create-owner.sh --slug <slug> --name <name> \
#     --pack <key@version> --locale <locale> --timezone <zone> \
#     --email <email> --owner-name <name>
# The generated password lands in /var/lib/tezda-secrets (root and the
# container user only); read it once, keep it in a password manager, delete it.
set -eu

cd "$(dirname "$0")"
out=/var/lib/tezda-secrets
install -d -m 700 -o 1000 -g 1000 "$out"
file="owner-$(date -u +%Y%m%dT%H%M%SZ).password"

docker compose --env-file .env.production \
  -f docker-compose.prod.yml -f docker-compose.local-db.yml \
  run --rm --no-deps -v "$out:/out" api \
  node dist/ops/create-tenant-owner.cli.js "$@" --password-file "/out/$file"

echo "read it once:  cat $out/$file"
echo "then delete:   rm $out/$file"
