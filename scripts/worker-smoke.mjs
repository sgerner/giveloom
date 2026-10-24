import EmbeddedPostgres from 'embedded-postgres';
import IORedis from 'ioredis';
import { Pool } from 'pg';
import { mkdtemp, mkdir, readFile, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';

const root = resolve(import.meta.dirname, '..');
const redisServer =
	process.env.REDIS_SERVER ||
	process.env.REDIS_SERVER_PATH ||
	'/tmp/giveloom-runtime/redis-7.4.2/src/redis-server';
const directory = await mkdtemp(join(tmpdir(), 'giveloom-worker-smoke-'));
const postgresPort = await freePort();
const redisPort = await freePort();
const readyPath = '/tmp/worker-ready';
const postgres = new EmbeddedPostgres({
	databaseDir: join(directory, 'pg'),
	user: 'postgres',
	password: 'worker-smoke-admin',
	port: postgresPort,
	persistent: false,
	onLog: () => {},
	onError: () => {}
});
let redisProcess;
let workerProcess;
let appPool;
let workerOutput = '';
let redisOutput = '';

function freePort() {
	return new Promise((resolvePort, reject) => {
		const server = createServer();
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const port = server.address().port;
			server.close((error) => (error ? reject(error) : resolvePort(port)));
		});
	});
}

function run(command, args, env = process.env) {
	return new Promise((resolveRun, reject) => {
		const child = spawn(command, args, { cwd: root, env, stdio: 'inherit' });
		child.once('error', reject);
		child.once('exit', (code) =>
			code === 0 ? resolveRun() : reject(new Error(`${command} ${args.join(' ')} exited ${code}`))
		);
	});
}

async function waitFor(check, label, timeoutMs = 15_000) {
	const until = Date.now() + timeoutMs;
	while (Date.now() < until) {
		if (await check()) return;
		await new Promise((resolveWait) => setTimeout(resolveWait, 150));
	}
	throw new Error(`Timed out waiting for ${label}`);
}

try {
	await unlink(readyPath).catch(() => {});
	await mkdir(join(directory, 'redis'));
	await postgres.initialise();
	await postgres.start();
	await postgres.createDatabase('worker_smoke');
	const migrationUrl = `postgresql://smoke_migrator:worker-smoke-migrator@127.0.0.1:${postgresPort}/worker_smoke`;
	const appUrl = `postgresql://smoke_app:worker-smoke-app@127.0.0.1:${postgresPort}/worker_smoke`;
	const bootstrap = new Pool({
		connectionString: `postgresql://postgres:worker-smoke-admin@127.0.0.1:${postgresPort}/worker_smoke`
	});
	try {
		await bootstrap.query(
			"CREATE ROLE smoke_app LOGIN PASSWORD 'worker-smoke-app' NOSUPERUSER NOBYPASSRLS"
		);
		await bootstrap.query(
			"CREATE ROLE smoke_migrator LOGIN PASSWORD 'worker-smoke-migrator' NOSUPERUSER NOBYPASSRLS"
		);
		await bootstrap.query('GRANT CREATE ON DATABASE worker_smoke TO smoke_migrator');
		await bootstrap.query('GRANT USAGE,CREATE ON SCHEMA public TO smoke_migrator');
		await bootstrap.query('GRANT USAGE ON SCHEMA public TO smoke_app');
		await bootstrap.query(
			'ALTER DEFAULT PRIVILEGES FOR ROLE smoke_migrator IN SCHEMA public GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO smoke_app'
		);
		await bootstrap.query('CREATE EXTENSION pgcrypto');
	} finally {
		await bootstrap.end();
	}
	await run('npm', ['run', 'db:migrate'], {
		...process.env,
		DATABASE_URL: migrationUrl,
		APP_DB_USER: 'smoke_app'
	});
	await run('npm', ['run', 'db:seed'], { ...process.env, DATABASE_URL: appUrl });
	appPool = new Pool({ connectionString: appUrl });
	const tenant = await appPool.query("SELECT id FROM tenants WHERE slug='riverstone'");
	if (!tenant.rowCount) throw new Error('Smoke tenant fixture was not seeded.');
	const tenantId = tenant.rows[0].id;
	const eventId = randomUUID();
	const client = await appPool.connect();
	try {
		await client.query('BEGIN');
		await client.query("SELECT set_config('app.tenant_id',$1,true)", [tenantId]);
		await client.query(
			`INSERT INTO outbox_events(id,tenant_id,event_type,payload,idempotency_key)
			VALUES($1,$2,'contacts.created',$3,$4)`,
			[eventId, tenantId, { resource: 'contacts', recordId: randomUUID() }, `smoke:${eventId}`]
		);
		await client.query('COMMIT');
	} catch (error) {
		await client.query('ROLLBACK');
		throw error;
	} finally {
		client.release();
	}

	redisProcess = spawn(
		redisServer,
		[
			'--bind',
			'127.0.0.1',
			'--port',
			String(redisPort),
			'--save',
			'',
			'--appendonly',
			'no',
			'--dir',
			join(directory, 'redis')
		],
		{ stdio: ['ignore', 'pipe', 'pipe'] }
	);
	redisProcess.stdout.setEncoding('utf8').on('data', (chunk) => (redisOutput += chunk));
	redisProcess.stderr.setEncoding('utf8').on('data', (chunk) => (redisOutput += chunk));
	const redis = new IORedis(`redis://127.0.0.1:${redisPort}`, { maxRetriesPerRequest: null });
	await waitFor(async () => (await redis.ping()) === 'PONG', 'local Redis readiness');
	await redis.quit();
	workerProcess = spawn('node', ['build/worker.js'], {
		cwd: root,
		env: {
			...process.env,
			DATABASE_URL: appUrl,
			REDIS_URL: `redis://127.0.0.1:${redisPort}`,
			JOB_SIGNING_SECRET: 'local-worker-smoke-job-signing-secret-32-bytes',
			OUTBOX_POLL_INTERVAL_MS: '100',
			WORKER_CONCURRENCY: '1'
		},
		stdio: ['ignore', 'pipe', 'pipe']
	});
	workerProcess.stdout.setEncoding('utf8').on('data', (chunk) => (workerOutput += chunk));
	workerProcess.stderr.setEncoding('utf8').on('data', (chunk) => (workerOutput += chunk));
	await waitFor(async () => {
		try {
			await readFile(readyPath, 'utf8');
			return true;
		} catch {
			return false;
		}
	}, 'worker ready marker');
	await waitFor(async () => {
		if (workerProcess.exitCode !== null)
			throw new Error(`Worker exited ${workerProcess.exitCode}: ${workerOutput}`);
		const check = await appPool.connect();
		try {
			await check.query('BEGIN');
			await check.query("SELECT set_config('app.tenant_id',$1,true)", [tenantId]);
			const result = await check.query(
				"SELECT 1 FROM audit_log WHERE tenant_id=$1 AND action='domain_event.observed' AND record_id=$2",
				[tenantId, eventId]
			);
			await check.query('COMMIT');
			return Boolean(result.rowCount);
		} finally {
			check.release();
		}
	}, 'signed no-provider outbox event processing').catch((error) => {
		throw new Error(
			`${error.message}\nWorker output: ${workerOutput}\nRedis output: ${redisOutput}`
		);
	});
	console.log(
		'Worker process smoke test passed: local PostgreSQL + real Redis, signed outbox dispatch, and tenant-scoped handler completed.'
	);
} finally {
	if (workerProcess?.exitCode === null) {
		workerProcess.kill('SIGTERM');
		await new Promise((resolveExit) => workerProcess.once('exit', resolveExit));
	}
	if (redisProcess?.exitCode === null) {
		redisProcess.kill('SIGTERM');
		await new Promise((resolveExit) => redisProcess.once('exit', resolveExit));
	}
	await appPool?.end();
	await postgres.stop().catch(() => {});
	await unlink(readyPath).catch(() => {});
	await rm(directory, { recursive: true, force: true });
}
