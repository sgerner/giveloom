import { env } from '$env/dynamic/private';
import type { PoolClient } from 'pg';
import { getPool } from './database';
import { getWorkspace } from './store';
export type TenantSession = NonNullable<App.Locals['session']>;
export class ServiceError extends Error {
	constructor(
		message: string,
		readonly status = 400
	) {
		super(message);
		this.name = 'ServiceError';
	}
}
export const editors = ['owner', 'admin', 'fundraising_manager', 'fundraiser'] as const;
export const financeRoles = ['owner', 'admin', 'finance', 'finance_manager'] as const;
export async function tenantTransaction<T>(
	session: App.Locals['session'],
	roles: readonly string[] | null,
	fn: (
		client: PoolClient,
		tenant: { id: string; slug: string; name: string; currency: string; role: string }
	) => Promise<T>
): Promise<T> {
	if (!session) throw new ServiceError('Sign in first.', 401);
	if (session.demo) throw new ServiceError('This operation requires a persistent database.', 503);
	const client = await getPool().connect();
	try {
		await client.query('BEGIN');
		const t = await client.query(
			'SELECT id,slug,legal_name,currency FROM tenants WHERE slug=$1 AND suspended_at IS NULL',
			[session.tenantSlug]
		);
		if (!t.rowCount) throw new ServiceError('Workspace not found.', 404);
		await client.query("SELECT set_config('app.tenant_id',$1,true)", [t.rows[0].id]);
		const m = await client.query(
			"SELECT m.role FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.tenant_id=$1 AND m.user_id=$2 AND m.status='active' AND u.disabled_at IS NULL",
			[t.rows[0].id, session.userId]
		);
		if (!m.rowCount) throw new ServiceError('Your workspace membership is no longer active.', 403);
		const role = String(m.rows[0].role);
		if (roles && !roles.includes(role))
			throw new ServiceError('Your role cannot perform this action.', 403);
		const result = await fn(client, {
			id: t.rows[0].id,
			slug: t.rows[0].slug,
			name: t.rows[0].legal_name,
			currency: String(t.rows[0].currency).trim(),
			role
		});
		await client.query('COMMIT');
		return result;
	} catch (error) {
		await client.query('ROLLBACK').catch(() => {});
		throw error;
	} finally {
		client.release();
	}
}
export async function demoAuthorization(
	session: App.Locals['session'],
	roles: readonly string[] | null = null
) {
	if (!session) throw new ServiceError('Sign in first.', 401);
	if (!session.demo || process.env.NODE_ENV === 'production')
		throw new ServiceError('Synthetic demo is unavailable.', 403);
	if (roles && !roles.includes(session.role))
		throw new ServiceError('Your role cannot perform this action.', 403);
	const w = await getWorkspace(session.tenantSlug);
	if (!w) throw new ServiceError('Workspace not found.', 404);
	return w;
}
export async function assertContact(client: PoolClient, tenantId: string, contactId: string) {
	const row = await client.query(
		'SELECT id,name,email,data FROM contacts WHERE tenant_id=$1 AND id=$2 AND archived_at IS NULL',
		[tenantId, contactId]
	);
	if (!row.rowCount) throw new ServiceError('Contact not found in your workspace.', 404);
	return row.rows[0];
}
export async function serviceAudit(
	client: PoolClient,
	tenantId: string,
	actorId: string,
	action: string,
	resource: string,
	recordId?: string,
	details: unknown = {}
) {
	await client.query(
		'INSERT INTO audit_log(tenant_id,actor_id,action,resource,record_id,details) VALUES($1,$2,$3,$4,$5,$6)',
		[tenantId, actorId, action, resource, recordId || null, details]
	);
}
export async function serviceEvent(
	client: PoolClient,
	tenantId: string,
	eventType: string,
	payload: unknown,
	key: string
) {
	await client.query(
		'INSERT INTO outbox_events(tenant_id,event_type,payload,idempotency_key) VALUES($1,$2,$3,$4) ON CONFLICT(idempotency_key) DO NOTHING',
		[tenantId, eventType, payload, key]
	);
}
export function serviceResponseError(error: unknown) {
	const code = String((error as { code?: unknown })?.code || '');
	const status =
		error instanceof ServiceError
			? error.status
			: (error as { name?: string })?.name === 'ZodError'
				? 422
				: code === '23505'
					? 409
					: code === '23503'
						? 422
						: code === '42501'
							? 403
							: 500;
	return {
		status,
		error:
			error instanceof ServiceError
				? error.message
				: status === 422
					? 'Invalid values or a reference outside your workspace.'
					: status === 409
						? 'This record conflicts with an existing value.'
						: 'The operation could not be completed.'
	};
}
