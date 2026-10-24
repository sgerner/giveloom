import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

const dev = process.argv.includes('--dev');
const domain = process.argv.find((arg) => arg.startsWith('--domain='))?.slice(9);
if (!dev && (!domain || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain))) {
	throw new Error('Usage: node scripts/setup-env.mjs --dev OR --domain=crm.example.org');
}
const secret = () => randomBytes(32).toString('hex');
const adminPassword = secret();
const appPassword = secret();
const migrationPassword = secret();
const host = dev ? '127.0.0.1:55432' : 'postgres:5432';
const values = {
	APP_DOMAIN: domain || 'localhost',
	ACME_EMAIL: '',
	POSTGRES_PASSWORD: adminPassword,
	APP_DB_PASSWORD: appPassword,
	MIGRATION_PASSWORD: migrationPassword,
	DATABASE_URL: `postgresql://donor_crm_app:${appPassword}@${host}/donor_crm`,
	MIGRATION_DATABASE_URL: `postgresql://donor_crm_migrator:${migrationPassword}@${host}/donor_crm`,
	SESSION_SECRET: secret(),
	DEMO_SESSION_SECRET: secret(),
	EMAIL_SIGNING_SECRET: secret(),
	FILE_SIGNING_SECRET: secret(),
	JOB_SIGNING_SECRET: secret(),
	CREDENTIAL_VAULT_KEY: randomBytes(32).toString('base64')
};
let template = await readFile(new URL('../.env.example', import.meta.url), 'utf8');
for (const [key, value] of Object.entries(values)) {
	template = template.replace(new RegExp(`^${key}=.*$`, 'm'), `${key}=${value}`);
}
if (dev) template += '\nREDIS_URL=redis://127.0.0.1:56379\nPUBLIC_APP_URL=http://localhost:5173\n';
await writeFile('.env', template, { flag: 'wx', mode: 0o600 });
console.log(
	'Created private .env with distinct random secrets. Existing files are never overwritten.'
);
if (!dev) console.log('Set ACME_EMAIL and configure providers before enabling email or payments.');
