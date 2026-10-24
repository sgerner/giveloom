#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
	printf 'Usage: %s <database-backup.dump> <files-backup.tar.gz>\n' "$0" >&2
	exit 2
fi
db_backup="$1"
files_backup="$2"
for name in "$db_backup" "$files_backup"; do
	if [[ "$name" != "$(basename "$name")" ]]; then
		printf 'Backup arguments must be filenames stored in the Compose backups volume.\n' >&2
		exit 2
	fi
	if [[ ! "$name" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ || "$name" == *..* ]]; then
		printf 'Backup filenames may contain only letters, numbers, dots, underscores, and hyphens.\n' >&2
		exit 2
	fi
done
[[ "$db_backup" == database-*.dump && "$files_backup" == files-*.tar.gz ]] || {
	printf 'Select one database dump and its paired files archive.\n' >&2
	exit 2
}
db_stamp="${db_backup#database-}"
db_stamp="${db_stamp%.dump}"
files_stamp="${files_backup#files-}"
files_stamp="${files_stamp%.tar.gz}"
[[ "$db_stamp" == "$files_stamp" ]] || {
	printf 'Database and files archives must have the same backup timestamp.\n' >&2
	exit 2
}

cd "$(dirname "$0")/.."
printf 'Restore replaces the current database and uploaded/exported files. Stop application traffic and confirm you selected the intended backups.\n' >&2
docker compose stop reverse-proxy worker
docker compose exec -T web sh -ec 'tar -tzf "/backups/$1"' sh "$files_backup" | awk '
  /^uploads\/$|^exports\/$/ { next }
  !/^(uploads|exports)\/[^/]+(\/[^/]+)*$/ { exit 1 }
  /(^|\/)\.\.(\/|$)/ { exit 1 }
' || {
	printf 'Files archive contains paths outside uploads/ and exports/.\n' >&2
	exit 2
}
docker compose exec -T postgres sh -ec "psql --set ON_ERROR_STOP=1 --username \"\$POSTGRES_USER\" --dbname \"\$POSTGRES_DB\" --command 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;'"
docker compose exec -T web sh -ec 'cat "/backups/$1"' sh "$db_backup" | docker compose exec -T postgres sh -ec "pg_restore --no-owner --username \"\$POSTGRES_USER\" --dbname \"\$POSTGRES_DB\""
docker compose exec -T web sh -ec 'find /data/uploads /data/exports -mindepth 1 -delete && tar -xzf "/backups/$1" -C /data' sh "$files_backup"
docker compose up -d migrate web worker reverse-proxy
printf 'Restore commands completed. Confirm service health and tenant-scoped records before reopening traffic.\n'
