import { createHash, createHmac, randomBytes } from 'node:crypto';
import argon2 from 'argon2';
import EmbeddedPostgres from 'embedded-postgres';
import { Pool } from 'pg';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
const directory = await mkdtemp(join(tmpdir(), 'donor-crm-tests-'));
const listener = createServer();
await new Promise((r) => listener.listen(0, '127.0.0.1', r));
const port = listener.address().port;
await new Promise((r) => listener.close(r));
const postgres = new EmbeddedPostgres({
	databaseDir: join(directory, 'pg'),
	user: 'postgres',
	password: 'ephemeral-admin-test',
	port,
	persistent: false,
	onLog: () => {},
	onError: () => {}
});
function run(args, env) {
	return new Promise((resolve, reject) => {
		const child = spawn('npm', args, { stdio: 'inherit', env: { ...process.env, ...env } });
		child.on('error', reject);
		child.on('exit', (code) =>
			code === 0 ? resolve() : reject(new Error('Verification failed: npm ' + args.join(' ')))
		);
	});
}
try {
	await postgres.initialise();
	await postgres.start();
	await postgres.createDatabase('donor_crm_test');
	const admin = new Pool({
		connectionString: `postgresql://postgres:ephemeral-admin-test@127.0.0.1:${port}/donor_crm_test`
	});
	try {
		await admin.query(
			"CREATE ROLE test_app LOGIN PASSWORD 'ephemeral-app-test' NOSUPERUSER NOBYPASSRLS"
		);
		await admin.query(
			"CREATE ROLE test_migrator LOGIN PASSWORD 'ephemeral-migration-test' NOSUPERUSER NOBYPASSRLS"
		);
		await admin.query('GRANT CREATE ON DATABASE donor_crm_test TO test_migrator');
		await admin.query('GRANT USAGE,CREATE ON SCHEMA public TO test_migrator');
		await admin.query('GRANT USAGE ON SCHEMA public TO test_app');
		await admin.query(
			'ALTER DEFAULT PRIVILEGES FOR ROLE test_migrator IN SCHEMA public GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO test_app'
		);
		await admin.query('CREATE EXTENSION pgcrypto');
	} finally {
		await admin.end();
	}
	const migrationEnv = {
		DATABASE_URL: `postgresql://test_migrator:ephemeral-migration-test@127.0.0.1:${port}/donor_crm_test`,
		APP_DB_USER: 'test_app'
	};
	const testEnv = {
		RUN_POSTGRES_MUTATION_TESTS: 'true',
		DATABASE_URL: `postgresql://test_app:ephemeral-app-test@127.0.0.1:${port}/donor_crm_test`
	};
	await run(['run', 'db:migrate'], migrationEnv);
	// Running again verifies migration tracking does not replay migrations.
	await run(['run', 'db:migrate'], migrationEnv);
	await run(['run', 'db:seed'], testEnv);
	if (process.env.TEST_BROWSER_ONLY !== 'true') await run(['test'], testEnv);
	if (process.env.RUN_BROWSER_TESTS === 'true') {
		const browserEnv = {
			SESSION_SECRET: 'browser-test-only-session-secret-not-for-deployment',
			PLAYWRIGHT_DB_TEST: 'true'
		};
		const fixture = new Pool({ connectionString: testEnv.DATABASE_URL });
		const client = await fixture.connect();
		try {
			const userId = crypto.randomUUID();
			await client.query('BEGIN');
			await client.query("SELECT set_config('app.signup_user_id',$1,true)", [userId]);
			await client.query(
				'INSERT INTO users(id,email,display_name,password_hash,email_verified_at) VALUES($1,$2,$3,$4,now())',
				[
					userId,
					'browser@example.test',
					'Browser Test Owner',
					await argon2.hash('Browser-only-test-password-2026!')
				]
			);
			await client.query('COMMIT');
			const tenants = await client.query(
				"SELECT id FROM tenants WHERE slug IN ('riverstone','harbor')"
			);
			for (const tenant of tenants.rows) {
				await client.query('BEGIN');
				await client.query("SELECT set_config('app.tenant_id',$1,true)", [tenant.id]);
				await client.query(
					"INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'owner')",
					[tenant.id, userId]
				);
				await client.query('COMMIT');
			}
		} catch (error) {
			client.release();
			await fixture.end();
			throw error;
		}
		try {
			const tenant = (await client.query("SELECT id FROM tenants WHERE slug='riverstone'")).rows[0];
			await client.query('BEGIN');
			await client.query("SELECT set_config('app.tenant_id',$1,true)", [tenant.id]);
			const contact = (
				await client.query(
					'SELECT id,name,email FROM contacts WHERE tenant_id=$1 AND email IS NOT NULL ORDER BY id LIMIT 1',
					[tenant.id]
				)
			).rows[0];
			const linkId = crypto.randomUUID(),
				payload = Buffer.from(
					JSON.stringify({
						tenantId: tenant.id,
						linkId,
						nonce: randomBytes(32).toString('base64url')
					})
				).toString('base64url'),
				key = createHash('sha256')
					.update('giveloom:portal-link-signing:v1:' + browserEnv.SESSION_SECRET)
					.digest(),
				token = payload + '.' + createHmac('sha256', key).update(payload).digest('base64url');
			await client.query(
				"INSERT INTO portal_magic_links(id,tenant_id,contact_id,token_hash,token_ciphertext,expires_at,sent_at,delivery_status) VALUES($1,$2,$3,$4,'',now()+interval '15 minutes',now(),'sent')",
				[linkId, tenant.id, contact.id, createHash('sha256').update(token).digest('hex')]
			);
			browserEnv.PORTAL_BROWSER_TOKEN = token;
			browserEnv.PORTAL_BROWSER_EMAIL = contact.email;
			browserEnv.PORTAL_BROWSER_CONTACT_NAME = contact.name;
			const eventId = crypto.randomUUID(),
				ticketId = crypto.randomUUID();
			await client.query(
				"INSERT INTO events(tenant_id,id,name,public_slug,description,starts_at,timezone,capacity,status,published_at) VALUES($1,$2,'Browser Community Gathering','browser-free-event','An explicitly synthetic free event used only by browser tests.',now()+interval '7 days','America/Phoenix',5,'published',now())",
				[tenant.id, eventId]
			);
			await client.query(
				"INSERT INTO event_ticket_types(tenant_id,id,event_id,name,price_minor,currency,capacity) VALUES($1,$2,$3,'Free admission',0,'USD',5)",
				[tenant.id, ticketId, eventId]
			);
			await client.query(
				"INSERT INTO contacts(tenant_id,name,email,stage,tags,data) SELECT $1,'A Browser Scale '||lpad(i::text,3,'0'),'browser-scale-'||i||'@example.test','new',ARRAY[]::text[],'{}'::jsonb FROM generate_series(1,205) i",
				[tenant.id]
			);
			browserEnv.BROWSER_EVENT_ID = eventId;
			browserEnv.BROWSER_TICKET_ID = ticketId;
			await client.query('COMMIT');
		} finally {
			client.release();
			await fixture.end();
		}
		await run(['run', 'test:browser:db'], { ...testEnv, ...browserEnv });
	}

	console.log('Blank install, repeat migration, seed and non-superuser PostgreSQL checks passed.');
} finally {
	await postgres.stop().catch(() => {});
	await rm(directory, { recursive: true, force: true });
}
