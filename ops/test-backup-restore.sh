#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
runtime_bin="$root/node_modules/@embedded-postgres/linux-x64/native/bin"
tmp="$(mktemp -d)"
port="$(node -e 'const n=require("node:net").createServer();n.listen(0,"127.0.0.1",()=>{console.log(n.address().port);n.close()})')"
pg_ctl_bin="${PG_CTL:-$runtime_bin/pg_ctl}"
initdb_bin="${INITDB:-$runtime_bin/initdb}"
started=0
cleanup() {
	if (( started )); then "$pg_ctl_bin" -D "$tmp/pg" -m immediate stop >/dev/null 2>&1 || true; fi
	rm -rf "$tmp"
}
trap cleanup EXIT

for tool in "$initdb_bin" "$pg_ctl_bin" "$(command -v pg_dump)" "$(command -v pg_restore)" "$(command -v psql)"; do
	[[ -x "$tool" ]] || { printf 'Required PostgreSQL tool unavailable: %s\n' "$tool" >&2; exit 2; }
done

mkdir -p "$tmp/socket" "$tmp/data/uploads" "$tmp/data/exports"
"$initdb_bin" -D "$tmp/pg" --auth=trust --username=postgres --no-locale >/dev/null
"$pg_ctl_bin" -D "$tmp/pg" -l "$tmp/postgres.log" -o "-F -h 127.0.0.1 -p $port -k $tmp/socket" start >/dev/null
started=1
pg=(psql -X -v ON_ERROR_STOP=1 -h 127.0.0.1 -p "$port" -U postgres -d backup_drill)
createdb -h 127.0.0.1 -p "$port" -U postgres backup_drill

printf 'paired-upload-v1\n' > "$tmp/data/uploads/paired-fixture.txt"
printf 'export-fixture-v1\n' > "$tmp/data/exports/paired-export.csv"
expected_upload="$(sha256sum "$tmp/data/uploads/paired-fixture.txt" | cut -d' ' -f1)"
expected_export="$(sha256sum "$tmp/data/exports/paired-export.csv" | cut -d' ' -f1)"
"${pg[@]}" <<'SQL' >/dev/null
CREATE TABLE upload_fixture (id integer PRIMARY KEY, relative_path text NOT NULL, sha256 text NOT NULL);
INSERT INTO upload_fixture VALUES
  (1, 'paired-fixture.txt', 'PLACEHOLDER');
SQL
"${pg[@]}" -c "UPDATE upload_fixture SET sha256='$expected_upload' WHERE id=1" >/dev/null

stamp="fixture"
pg_dump --format=custom --no-owner -h 127.0.0.1 -p "$port" -U postgres -d backup_drill > "$tmp/database-$stamp.dump"
tar -C "$tmp/data" -czf "$tmp/files-$stamp.tar.gz" uploads exports

# Damage both halves, then restore the database and the matching files archive.
printf 'damaged-upload\n' > "$tmp/data/uploads/paired-fixture.txt"
rm "$tmp/data/exports/paired-export.csv"
"${pg[@]}" -c "UPDATE upload_fixture SET relative_path='missing.txt',sha256='damaged' WHERE id=1" >/dev/null
dropdb -h 127.0.0.1 -p "$port" -U postgres backup_drill
createdb -h 127.0.0.1 -p "$port" -U postgres backup_drill
pg_restore --no-owner -h 127.0.0.1 -p "$port" -U postgres -d backup_drill "$tmp/database-$stamp.dump"
find "$tmp/data/uploads" "$tmp/data/exports" -mindepth 1 -delete
tar -xzf "$tmp/files-$stamp.tar.gz" -C "$tmp/data"

restored="$("${pg[@]}" -Atc "SELECT relative_path || ':' || sha256 FROM upload_fixture WHERE id=1")"
[[ "$restored" == "paired-fixture.txt:$expected_upload" ]]
[[ "$(sha256sum "$tmp/data/uploads/paired-fixture.txt" | cut -d' ' -f1)" == "$expected_upload" ]]
[[ "$(sha256sum "$tmp/data/exports/paired-export.csv" | cut -d' ' -f1)" == "$expected_export" ]]
printf 'Isolated backup/restore drill passed: database references and both uploaded/exported files restored from the paired archives.\n'
