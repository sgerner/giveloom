import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { env } from '$env/dynamic/private';
import { demoAuthorization, type TenantSession, ServiceError } from './tenant-service';
export type DemoRecord = { id: string; [key: string]: any };
type Store = Record<string, Record<string, DemoRecord[]>>;
const file =
	env.DEMO_EXTENSIONS_PATH ||
	(env.DEMO_DATA_PATH ? env.DEMO_DATA_PATH + '.extensions' : '.data/donor-crm-extensions.json');
let pending: Promise<unknown> = Promise.resolve();
async function read(): Promise<Store> {
	try {
		return JSON.parse(await readFile(file, 'utf8'));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
		throw new ServiceError('Demo extension data could not be read.', 503);
	}
}
export async function demoRead(session: TenantSession, resource: string) {
	await demoAuthorization(session);
	const db = await read();
	return structuredClone(db[session.tenantSlug]?.[resource] || []);
}
export async function demoWrite<T>(
	session: TenantSession,
	roles: readonly string[] | null,
	fn: (records: Record<string, DemoRecord[]>) => Promise<T> | T
): Promise<T> {
	await demoAuthorization(session, roles);
	const task = pending.then(async () => {
		const db = await read();
		db[session.tenantSlug] ||= {};
		const result = await fn(db[session.tenantSlug]);
		await mkdir(dirname(file), { recursive: true });
		const tmp = file + '.' + process.pid + '.tmp';
		await writeFile(tmp, JSON.stringify(db), { mode: 0o600 });
		await rename(tmp, file);
		return structuredClone(result);
	});
	pending = task.catch(() => {});
	return task;
}
