#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
db_tmp="$(mktemp)"
restart_services() {
	 rm -f "$db_tmp"
	 docker compose start worker reverse-proxy >/dev/null 2>&1 || true
}
trap restart_services EXIT

docker compose stop reverse-proxy worker
docker compose exec -T postgres sh -ec 'pg_dump --format=custom --no-owner --username "$POSTGRES_USER" "$POSTGRES_DB"' > "$db_tmp"
docker compose exec -T web sh -ec "cat > /backups/database-$stamp.dump" < "$db_tmp"
docker compose exec -T web sh -ec "tar -C /data -czf /backups/files-$stamp.tar.gz uploads exports && chmod 600 /backups/database-$stamp.dump /backups/files-$stamp.tar.gz"
printf 'Created database-%s.dump and files-%s.tar.gz in the Compose backups volume.\n' "$stamp" "$stamp"
