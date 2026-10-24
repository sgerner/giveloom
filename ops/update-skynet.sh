#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

# Runs inside the updater container. The repository is mounted at the same
# absolute path on the host so Compose bind mounts and build contexts resolve.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE_DIR="${UPDATE_STATE_DIR:-/state}"
DEPLOYED_FILE="$STATE_DIR/deployed-sha"
BLOCKED_FILE="$STATE_DIR/blocked-sha"
REMOTE="${UPDATE_REMOTE:-${UPDATE_REPO_URL:-origin}}"
BRANCH="${UPDATE_BRANCH:-main}"
INTERVAL="${UPDATE_INTERVAL_SECONDS:-900}"
COMPOSE_FILE="${COMPOSE_FILE:-compose.skynet.yml}"
PROJECT="${COMPOSE_PROJECT_NAME:-giveloom}"
COMMAND_TIMEOUT_SECONDS="${UPDATE_COMMAND_TIMEOUT_SECONDS:-1800}"

cd "$ROOT"
mkdir -p "${HOME:-/tmp/giveloom-updater}"
mkdir -p "$STATE_DIR/backups"
chmod 700 "$STATE_DIR"

exec 9>"$STATE_DIR/update.lock"
if ! flock -n 9; then
	printf '[skynet-updater] Another updater process already holds the lock.\n'
	exit 0
fi

compose() {
	docker compose --project-name "$PROJECT" --file "$COMPOSE_FILE" "$@"
}

git_safe() {
	git -c "safe.directory=$ROOT" "$@"
}

with_timeout() {
	timeout --signal=TERM --kill-after=30s "${COMMAND_TIMEOUT_SECONDS}s" "$@"
}

log() {
	printf '[skynet-updater] %s\n' "$*"
}

read_sha_file() {
	local value
	[[ -f "$1" ]] || return 1
	IFS= read -r value < "$1" || true
	[[ "$value" =~ ^[0-9a-f]{40}$ ]] || {
		log "Invalid SHA in $1; refusing to continue."
		return 2
	}
	printf '%s' "$value"
}

write_sha_file() {
	local file="$1" sha="$2" tmp
	tmp="$(mktemp "$STATE_DIR/.sha.XXXXXX")" || return 1
	if ! printf '%s\n' "$sha" > "$tmp" || ! chmod 600 "$tmp" || ! mv -f "$tmp" "$file"; then
		rm -f "$tmp"
		return 1
	fi
}

persist_app_version() {
	local sha="$1" tmp
	[[ -f "$ROOT/.env" ]] || return 1
	tmp="$(mktemp "$ROOT/.env.update.XXXXXX")" || return 1
	if ! awk -v version="$sha" '
		/^APP_VERSION=/ {
			if (!written++) print "APP_VERSION=" version
			next
		}
		{ print }
		END { if (!written) print "APP_VERSION=" version }
	' "$ROOT/.env" > "$tmp"; then
		rm -f "$tmp"
		return 1
	fi
	if ! chmod 600 "$tmp" || ! mv -f "$tmp" "$ROOT/.env"; then
		rm -f "$tmp"
		return 1
	fi
}

update_once() {
	local old_sha target_sha current_branch stamp backup_dir db_dump files_tar

	if [[ -e "$BLOCKED_FILE" ]]; then
		log "Updates are paused after a migration failure. Review the incident, then remove $BLOCKED_FILE to resume."
		return 0
	fi
	old_sha="$(read_sha_file "$DEPLOYED_FILE")" || {
		log 'The initial deployed-sha marker is missing or invalid; refusing to update.'
		return 1
	}
	export APP_VERSION="$old_sha"
	if ! current_branch="$(git_safe branch --show-current)"; then
		log 'Could not inspect the deployment branch.'
		return 1
	fi
	if [[ "$current_branch" != "$BRANCH" ]]; then
		log "Expected checked-out branch $BRANCH; found ${current_branch:-detached HEAD}."
		return 1
	fi
	local worktree_status
	if ! worktree_status="$(git_safe status --porcelain)"; then
		log 'Could not inspect the repository worktree.'
		return 1
	fi
	if [[ -n "$worktree_status" ]]; then
		log 'Repository has local changes; refusing to update.'
		return 1
	fi

	if ! with_timeout git -c "safe.directory=$ROOT" fetch --quiet "$REMOTE" "$BRANCH"; then
		log 'Could not fetch the update source.'
		return 1
	fi
	if ! target_sha="$(git_safe rev-parse "FETCH_HEAD^{commit}")"; then
		log 'Could not resolve the fetched revision.'
		return 1
	fi
	if [[ ! "$target_sha" =~ ^[0-9a-f]{40}$ ]]; then
		log 'Fetched revision is not a full commit SHA.'
		return 1
	fi
	if [[ "$target_sha" == "$old_sha" ]]; then
		log "Already deployed ${target_sha:0:12}."
		return 0
	fi

	# Never reset or discard work. Advance only the checked-out deployment branch.
	if ! git_safe merge --ff-only "$target_sha" >/dev/null; then
		log 'Update is not a fast-forward; manual repository repair is required.'
		return 1
	fi
	local head_sha
	if ! head_sha="$(git_safe rev-parse HEAD)" || [[ "$head_sha" != "$target_sha" ]]; then
		log 'Checkout did not advance to the fetched revision.'
		return 1
	fi

	log "Building application image for ${target_sha:0:12}."
	if ! with_timeout env APP_VERSION="$target_sha" docker compose --project-name "$PROJECT" --file "$COMPOSE_FILE" build web worker migrate; then
		log 'Image build failed; deployed services and marker are unchanged.'
		return 1
	fi

	# Ensure data services are healthy before taking the paired pre-upgrade backup.
	if ! compose up -d --wait postgres redis; then
		log 'Could not make PostgreSQL and Redis healthy; update deferred.'
		return 1
	fi
	if ! compose stop web worker; then
		APP_VERSION="$old_sha" compose start web worker >/dev/null 2>&1 || true
		log 'Could not stop application services; update deferred.'
		return 1
	fi

	if ! stamp="$(date -u +%Y%m%dT%H%M%SZ)"; then
		APP_VERSION="$old_sha" compose start web worker >/dev/null 2>&1 || true
		log 'Could not create a backup timestamp; old application services were restarted.'
		return 1
	fi
	backup_dir="$STATE_DIR/backups/$stamp"
	if ! mkdir -m 700 "$backup_dir"; then
		APP_VERSION="$old_sha" compose start web worker >/dev/null 2>&1 || true
		log 'Could not create the private backup directory; old application services were restarted.'
		return 1
	fi
	db_dump="$backup_dir/database.dump"
	files_tar="$backup_dir/files.tar.gz"
	if ! compose exec -T postgres sh -ec 'pg_dump --format=custom --no-owner --username "$POSTGRES_USER" "$POSTGRES_DB"' > "$db_dump"; then
		rm -rf "$backup_dir"
		APP_VERSION="$old_sha" compose start web worker >/dev/null 2>&1 || true
		log 'Database backup failed; old application services were restarted.'
		return 1
	fi
	if ! compose run --rm --no-deps --entrypoint tar web -C /data -czf - uploads exports > "$files_tar"; then
		rm -rf "$backup_dir"
		APP_VERSION="$old_sha" compose start web worker >/dev/null 2>&1 || true
		log 'Files backup failed; old application services were restarted.'
		return 1
	fi
	if ! chmod 600 "$db_dump" "$files_tar"; then
		APP_VERSION="$old_sha" compose start web worker >/dev/null 2>&1 || true
		log 'Could not secure the backup files; old application services were restarted.'
		return 1
	fi
	if [[ ! -s "$db_dump" || ! -s "$files_tar" ]]; then
		rm -rf "$backup_dir"
		APP_VERSION="$old_sha" compose start web worker >/dev/null 2>&1 || true
		log 'A backup artifact is empty; old application services were restarted.'
		return 1
	fi
	log "Paired backup saved at $backup_dir."

	if ! compose run --rm --no-deps db-bootstrap; then
		APP_VERSION="$old_sha" compose start web worker >/dev/null 2>&1 || true
		log 'Database bootstrap failed; migration did not run and the deployed SHA is unchanged.'
		return 1
	fi
	if ! with_timeout env APP_VERSION="$target_sha" docker compose --project-name "$PROJECT" --file "$COMPOSE_FILE" run --rm --no-deps migrate; then
		compose stop web worker >/dev/null 2>&1 || true
		if ! write_sha_file "$BLOCKED_FILE" "$target_sha"; then
			log 'Could not persist the migration failure pause marker; stopping the updater for operator attention.'
			exit 1
		fi
		log "Migration failed. Application services remain stopped; inspect logs and restore/recover manually. Updates are paused by $BLOCKED_FILE."
		return 1
	fi

	if ! APP_VERSION="$target_sha" compose up -d --no-deps --wait web worker; then
		compose stop web worker >/dev/null 2>&1 || true
		if ! write_sha_file "$BLOCKED_FILE" "$target_sha"; then
			log 'Could not persist the health failure pause marker; stopping the updater for operator attention.'
			exit 1
		fi
		log "New application health checks failed. Application services remain stopped; inspect service logs and recover manually. Updates are paused by $BLOCKED_FILE."
		return 1
	fi
	if ! persist_app_version "$target_sha"; then
		log 'Deployment is healthy, but APP_VERSION could not be saved to .env; deployed SHA marker is unchanged.'
		return 1
	fi
	if ! write_sha_file "$DEPLOYED_FILE" "$target_sha"; then
		log 'Deployment is healthy, but deployed-sha could not be saved; operator attention is required.'
		return 1
	fi
	log "Deployment healthy at ${target_sha:0:12}."
}

run_iteration() {
	update_once
}

if [[ "${UPDATE_ONCE:-false}" == 'true' ]]; then
	run_iteration
	exit $?
fi

while true; do
	if ! run_iteration; then
		log 'Update attempt failed; the previous deployed-sha marker was preserved.'
	fi
	sleep "$INTERVAL"
done
