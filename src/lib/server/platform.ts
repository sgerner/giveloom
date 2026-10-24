import { z } from 'zod';
import { env } from '$env/dynamic/private';
import { getPool, workspaceFromPostgres } from './database';
import { ServiceError } from './tenant-service';
export async function requirePlatformOperator(session: App.Locals['session']) {
	if (!session || session.demo) throw new ServiceError('Sign in as a platform operator.', 401);
	const allowed = (process.env.PLATFORM_ADMIN_EMAILS || env.PLATFORM_ADMIN_EMAILS || '')
		.split(',')
		.map((s) => s.trim().toLowerCase())
		.filter(Boolean);
	if (!allowed.length) throw new ServiceError('Platform administration is not configured.', 503);
	const w = await workspaceFromPostgres(session.tenantSlug, session.userId, session.role);
	if (!w || !allowed.includes(String(w.user?.email).toLowerCase()))
		throw new ServiceError('Platform operator access is required.', 403);
	return session;
}
const schema = z.discriminatedUnion('action', [
	z
		.object({
			action: z.literal('create'),
			slug: z
				.string()
				.min(3)
				.max(72)
				.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
			legalName: z.string().trim().min(2).max(180),
			currency: z.string().length(3).default('USD'),
			timezone: z.string().max(80).default('UTC'),
			confirmed: z.literal(true)
		})
		.strict(),
	z
		.object({
			action: z.literal('suspend'),
			tenantId: z.uuid(),
			reason: z.string().trim().min(5).max(1000),
			confirmed: z.literal(true)
		})
		.strict(),
	z
		.object({
			action: z.literal('resume'),
			tenantId: z.uuid(),
			reason: z.string().trim().min(5).max(1000),
			confirmed: z.literal(true)
		})
		.strict(),
	z
		.object({
			action: z.literal('plan'),
			tenantId: z.uuid(),
			planLabel: z.string().trim().min(1).max(100),
			subscriptionStatus: z.enum(['self_hosted', 'trial', 'active', 'past_due', 'canceled']),
			reason: z.string().trim().min(5).max(1000),
			confirmed: z.literal(true)
		})
		.strict(),
	z
		.object({
			action: z.literal('assign_owner'),
			tenantId: z.uuid(),
			userId: z.uuid(),
			reason: z.string().trim().min(5).max(1000),
			confirmed: z.literal(true)
		})
		.strict()
]);
export async function platformCommand(session: App.Locals['session'], input: unknown) {
	const s = await requirePlatformOperator(session),
		command = schema.parse(input);
	const client = await getPool().connect();
	try {
		await client.query('BEGIN');
		await client.query("SELECT set_config('app.platform_operator_id',$1,true)", [s.userId]);
		let result: any;
		if (command.action === 'create') {
			if (!Intl.supportedValuesOf('currency').includes(command.currency))
				throw new ServiceError('Currency is invalid.', 422);
			try {
				new Intl.DateTimeFormat('en', { timeZone: command.timezone }).format();
			} catch {
				throw new ServiceError('Choose an IANA time zone.', 422);
			}
			result = (
				await client.query(
					'INSERT INTO tenants(slug,legal_name,currency,timezone) VALUES($1,$2,$3,$4) RETURNING id,slug,legal_name AS "legalName",currency,timezone',
					[command.slug, command.legalName, command.currency, command.timezone]
				)
			).rows[0];
			await client.query("SELECT set_config('app.tenant_id',$1,true)", [result.id]);
			await client.query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'owner')", [
				result.id,
				s.userId
			]);
			result.initialOwner =
				'The creating operator. Invite staff, then assign an existing active member as owner from this page.';
		} else {
			await client.query("SELECT set_config('app.tenant_id',$1,true)", [command.tenantId]);
			const t = await client.query('SELECT id,slug FROM tenants WHERE id=$1 FOR UPDATE', [
				command.tenantId
			]);
			if (!t.rowCount) throw new ServiceError('Tenant not found.', 404);
			if (command.action === 'suspend') {
				if (t.rows[0].slug === s.tenantSlug)
					throw new ServiceError(
						'Switch to another active tenant before suspending your current workspace.',
						409
					);
				await client.query(
					'UPDATE tenants SET suspended_at=now(),suspension_reason=$2 WHERE id=$1',
					[command.tenantId, command.reason]
				);
				await client.query(
					'UPDATE auth_sessions SET revoked_at=coalesce(revoked_at,now()) WHERE tenant_id=$1',
					[command.tenantId]
				);
				await client.query(
					"UPDATE portal_magic_links SET delivery_status='cancelled',token_ciphertext='' WHERE tenant_id=$1 AND delivery_status IN ('queued','sending')",
					[command.tenantId]
				);
				await client.query(
					'UPDATE integration_configs SET enabled=false,updated_at=now() WHERE tenant_id=$1',
					[command.tenantId]
				);
				await client.query('UPDATE webhook_endpoints SET enabled=false WHERE tenant_id=$1', [
					command.tenantId
				]);
				result = {
					suspended: true,
					tenantId: command.tenantId,
					integrations:
						'Provider and webhook connections are disabled. Existing Stripe subscriptions remain managed in Stripe.'
				};
			} else if (command.action === 'resume') {
				await client.query(
					'UPDATE tenants SET suspended_at=NULL,suspension_reason=NULL WHERE id=$1',
					[command.tenantId]
				);
				result = {
					resumed: true,
					tenantId: command.tenantId,
					integrations: 'Connections remain disabled until the tenant explicitly enables them.'
				};
			} else if (command.action === 'plan') {
				await client.query(
					'UPDATE tenants SET plan_label=$2,subscription_status=$3,subscription_updated_at=now() WHERE id=$1',
					[command.tenantId, command.planLabel, command.subscriptionStatus]
				);
				result = {
					tenantId: command.tenantId,
					updated: true,
					source: 'Operator-maintained plan tracking; no billing provider was contacted.'
				};
			} else {
				const member = await client.query(
					"SELECT 1 FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.tenant_id=$1 AND m.user_id=$2 AND m.status='active' AND u.disabled_at IS NULL AND u.email_verified_at IS NOT NULL",
					[command.tenantId, command.userId]
				);
				if (!member.rowCount)
					throw new ServiceError(
						'The new owner must be an active, verified member of this tenant.',
						422
					);
				await client.query(
					"UPDATE memberships SET role='owner' WHERE tenant_id=$1 AND user_id=$2",
					[command.tenantId, command.userId]
				);
				await client.query(
					'UPDATE auth_sessions SET revoked_at=coalesce(revoked_at,now()) WHERE tenant_id=$1 AND user_id=$2',
					[command.tenantId, command.userId]
				);
				result = { assigned: true, tenantId: command.tenantId, userId: command.userId };
			}
		}
		await client.query(
			'INSERT INTO platform_audit_events(actor_id,tenant_id,action,details) VALUES($1,$2,$3,$4)',
			[
				s.userId,
				result.id || result.tenantId,
				'tenant.' + command.action,
				{ ...command, confirmed: undefined }
			]
		);
		await client.query('COMMIT');
		return result;
	} catch (e) {
		await client.query('ROLLBACK').catch(() => {});
		throw e;
	} finally {
		client.release();
	}
}
export async function platformAudit(session: App.Locals['session']) {
	const s = await requirePlatformOperator(session);
	const c = await getPool().connect();
	try {
		await c.query('BEGIN');
		await c.query("SELECT set_config('app.platform_operator_id',$1,true)", [s.userId]);
		const rows = await c.query(
			'SELECT id,tenant_id AS "tenantId",actor_id AS "actorId",action,details,created_at AS "createdAt" FROM platform_audit_events ORDER BY created_at DESC,id DESC LIMIT 200'
		);
		await c.query('COMMIT');
		return { items: rows.rows };
	} catch (e) {
		await c.query('ROLLBACK').catch(() => {});
		throw e;
	} finally {
		c.release();
	}
}
