import { readdir, readFile } from 'node:fs/promises';
import { Pool } from 'pg';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL must be set to run database migrations.');
const pool = new Pool({ connectionString: url });
const client = await pool.connect();
const appDbUser = process.env.APP_DB_USER;
if (appDbUser && !/^[A-Za-z_][A-Za-z0-9_$]*$/.test(appDbUser))
	throw new Error('APP_DB_USER must be a plain PostgreSQL role identifier.');
async function revokeAppTrackingAccess() {
	if (!appDbUser) return;
	await client.query(`REVOKE ALL ON TABLE schema_migrations FROM "${appDbUser}"`);
}
try {
	await client.query(
		'CREATE TABLE IF NOT EXISTS schema_migrations(name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())'
	);
	await client.query('REVOKE ALL ON TABLE schema_migrations FROM PUBLIC');
	await revokeAppTrackingAccess();
	const applied = new Set(
		(await client.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name as string)
	);
	const files = (await readdir('migrations')).filter((name) => name.endsWith('.sql')).sort();
	for (const name of files) {
		if (applied.has(name)) continue;
		await client.query('BEGIN');
		try {
			await client.query(await readFile(`migrations/${name}`, 'utf8'));
			await client.query('INSERT INTO schema_migrations(name) VALUES($1)', [name]);
			await client.query('COMMIT');
			console.log(`Applied ${name}`);
		} catch (error) {
			await client.query('ROLLBACK');
			throw error;
		}
	}
	await revokeAppTrackingAccess();
} finally {
	client.release();
	await pool.end();
}
