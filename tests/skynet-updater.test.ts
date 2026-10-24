import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const oldSha = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const targetSha = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

describe('Skynet updater deployment safeguards', () => {
	let fixture: string;
	let repo: string;
	let state: string;
	let bin: string;
	let envFile: string;
	let dockerLog: string;

	beforeEach(() => {
		fixture = mkdtempSync(join(tmpdir(), 'giveloom-updater-test-'));
		repo = join(fixture, 'repo');
		state = join(fixture, 'state');
		bin = join(fixture, 'bin');
		mkdirSync(join(repo, 'ops'), { recursive: true });
		mkdirSync(state, { mode: 0o700 });
		mkdirSync(bin);
		mkdirSync(join(fixture, 'home'));
		writeFileSync(
			join(repo, 'ops/update-skynet.sh'),
			readFileSync(join(projectRoot, 'ops/update-skynet.sh'))
		);
		envFile = join(repo, '.env');
		writeFileSync(envFile, 'APP_VERSION=old\nOTHER=value\n', { mode: 0o600 });
		dockerLog = join(fixture, 'docker.log');

		writeExecutable(
			join(bin, 'git'),
			`#!/bin/sh
[ "$1" = -c ] && shift 2
case "$1" in
  branch) echo main ;;
  status) ;;
  fetch|merge) exit 0 ;;
  rev-parse) echo "$MOCK_TARGET" ;;
  *) exit 2 ;;
esac
`
		);
		writeExecutable(
			join(bin, 'docker'),
			`#!/bin/sh
printf '%s\\n' "$*" >> "$MOCK_DOCKER_LOG"
case "$*" in
  *'exec -T postgres'*) [ "\${MOCK_FAIL:-}" != backup ] || exit 16; echo database-dump ;;
  *'--entrypoint tar'*) echo files-archive ;;
  *'run --rm --no-deps migrate'*) [ "\${MOCK_FAIL:-}" != migrate ] || exit 17 ;;
  *'up -d --no-deps --wait web worker'*) [ "\${MOCK_FAIL:-}" != health ] || exit 18 ;;
esac
`
		);
		writeExecutable(
			join(bin, 'chmod'),
			`#!/bin/sh
case "$*" in
  *'.env.update.'*) [ "\${MOCK_FAIL:-}" != envwrite ] || exit 19 ;;
esac
exec /bin/chmod "$@"
`
		);
	});

	afterEach(() => {
		rmSync(fixture, { recursive: true, force: true });
	});

	it('deploys successfully with private paired backups and persists both revision markers', () => {
		const result = runUpdater();
		expect(result.status).toBe(0);
		expect(readFileSync(join(state, 'deployed-sha'), 'utf8')).toBe(`${targetSha}\n`);
		expect(readFileSync(envFile, 'utf8')).toBe(`APP_VERSION=${targetSha}\nOTHER=value\n`);
		expect(statSync(envFile).mode & 0o777).toBe(0o600);

		const backupDir = join(state, 'backups', readdirSync(join(state, 'backups'))[0]);
		expect(statSync(backupDir).mode & 0o777).toBe(0o700);
		for (const name of ['database.dump', 'files.tar.gz']) {
			const backup = join(backupDir, name);
			expect(statSync(backup).mode & 0o777).toBe(0o600);
			expect(readFileSync(backup, 'utf8').trim().length).toBeGreaterThan(0);
		}
		expect(existsSync(join(state, 'blocked-sha'))).toBe(false);
	});

	it('aborts on database backup failure and starts the old web and worker containers', () => {
		const result = runUpdater('backup');
		const log = readFileSync(dockerLog, 'utf8');
		expect(result.status).not.toBe(0);
		expect(readFileSync(join(state, 'deployed-sha'), 'utf8')).toBe(`${oldSha}\n`);
		expect(log).toContain('start web worker');
		expect(log).not.toContain('run --rm --no-deps migrate');
		expect(readdirSync(join(state, 'backups'))).toEqual([]);
	});

	it.each(['migrate', 'health'] as const)(
		'%s failure blocks updates and preserves the deployed revision',
		(failure) => {
			const result = runUpdater(failure);
			const log = readFileSync(dockerLog, 'utf8');
			expect(result.status).not.toBe(0);
			expect(readFileSync(join(state, 'deployed-sha'), 'utf8')).toBe(`${oldSha}\n`);
			expect(readFileSync(join(state, 'blocked-sha'), 'utf8')).toBe(`${targetSha}\n`);
			expect(log).toContain('stop web worker');
			expect(log).not.toContain('start web worker');
		}
	);

	it('preserves the original .env and deployed marker if persisting APP_VERSION fails', () => {
		const originalEnv = readFileSync(envFile, 'utf8');
		const result = runUpdater('envwrite');
		expect(result.status).not.toBe(0);
		expect(readFileSync(envFile, 'utf8')).toBe(originalEnv);
		expect(readFileSync(join(state, 'deployed-sha'), 'utf8')).toBe(`${oldSha}\n`);
		expect(existsSync(join(state, 'blocked-sha'))).toBe(false);
	});

	function runUpdater(failure?: 'backup' | 'migrate' | 'health' | 'envwrite') {
		writeFileSync(join(state, 'deployed-sha'), `${oldSha}\n`, { mode: 0o600 });
		writeFileSync(dockerLog, '');
		return spawnSync('bash', [join(repo, 'ops/update-skynet.sh')], {
			encoding: 'utf8',
			env: {
				...process.env,
				PATH: `${bin}:${process.env.PATH ?? ''}`,
				HOME: join(fixture, 'home'),
				UPDATE_STATE_DIR: state,
				UPDATE_ONCE: 'true',
				MOCK_TARGET: targetSha,
				MOCK_FAIL: failure ?? '',
				MOCK_DOCKER_LOG: dockerLog
			}
		});
	}

	function writeExecutable(path: string, content: string) {
		writeFileSync(path, content, { mode: 0o700 });
		chmodSync(path, 0o700);
	}
});
