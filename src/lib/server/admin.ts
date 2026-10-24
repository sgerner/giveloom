import { lookup as dnsLookup } from 'node:dns/promises';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { z } from 'zod';
import type { Pool } from 'pg';
import { env } from '$env/dynamic/private';
import { credentialVaultFromEnvironment } from '$lib/providers/vault.server';
import { getPool, workspaceFromPostgres } from './database';
import { authRateLimit } from './auth-rate-limit';
import { serviceAudit, tenantTransaction, type TenantSession } from './tenant-service';

const managerRoles = ['owner', 'admin'] as const;
const webhookEventTypes = [
	'automation.action',
	'contacts.created',
	'contact.created',
	'contacts.updated',
	'contacts.archived',
	'contact.merged',
	'contact.merge_undone',
	'tasks.created',
	'tasks.updated',
	'tasks.archived',
	'campaigns.created',
	'campaigns.updated',
	'campaigns.archived',
	'events.created',
	'events.updated',
	'events.archived',
	'prospects.created',
	'prospects.updated',
	'prospects.archived',
	'introductions.created',
	'introductions.updated',
	'introductions.archived',
	'email_drafts.created',
	'email_drafts.updated',
	'files.created',
	'files.archived',
	'donation.recorded',
	'payment.refunded',
	'gift.recorded',
	'gifts.created'
] as const;
const endpointSchema = z
	.object({
		label: z.string().trim().min(1).max(120),
		url: z.string().url().max(2048),
		events: z.array(z.enum(webhookEventTypes)).min(1).max(24),
		approved: z.literal(true)
	})
	.strict();
const retentionSchema = z
	.object({
		enabled: z.boolean(),
		aiRetentionDays: z.number().int().min(30).max(3650),
		webhookDeliveryRetentionDays: z.number().int().min(90).max(3650)
	})
	.strict();

export class AdminError extends Error {
	constructor(
		message: string,
		readonly status: number
	) {
		super(message);
		this.name = 'AdminError';
	}
}

async function authorizeManager(session: TenantSession) {
	if (!session || session.demo)
		throw new AdminError('Sign in to manage workspace integrations.', 401);
	const workspace = await workspaceFromPostgres(session.tenantSlug, session.userId, session.role);
	if (!workspace) throw new AdminError('Active workspace membership is unavailable.', 403);
	if (!managerRoles.includes(workspace.user.role as (typeof managerRoles)[number]))
		throw new AdminError('Only tenant owners and administrators can manage these settings.', 403);
}

export async function listWebhookEndpoints(session: TenantSession) {
	await authorizeManager(session);
	return tenantTransaction(session, managerRoles, async (client, tenant) => {
		const rows = await client.query(
			`SELECT e.id,e.label,e.target_url AS "targetUrl",e.events,e.enabled,e.created_at AS "createdAt",e.revoked_at AS "revokedAt",
		(SELECT count(*)::int FROM webhook_deliveries d WHERE d.tenant_id=e.tenant_id AND d.endpoint_id=e.id) AS "deliveryCount",
		(SELECT jsonb_agg(jsonb_build_object('id',d.id,'eventType',d.event_type,'status',d.status,'attempts',d.attempts,'responseStatus',d.response_status,'lastError',d.last_error,'createdAt',d.created_at) ORDER BY d.created_at DESC) FROM (SELECT * FROM webhook_deliveries WHERE tenant_id=e.tenant_id AND endpoint_id=e.id ORDER BY created_at DESC LIMIT 10) d) AS deliveries
		FROM webhook_endpoints e WHERE e.tenant_id=$1 ORDER BY e.created_at DESC LIMIT 100`,
			[tenant.id]
		);
		await serviceAudit(
			client,
			tenant.id,
			session.userId,
			'webhook_endpoint.list',
			'webhook_endpoints'
		);
		return { events: webhookEventTypes, endpoints: rows.rows };
	});
}

export function ipIsPublic(address: string) {
	const family = isIP(address);
	if (family === 4) {
		const p = address.split('.').map(Number);
		if (p.length !== 4 || p.some((n) => n < 0 || n > 255)) return false;
		const [a, b, c] = p;
		return !(
			a === 0 ||
			a === 10 ||
			a === 127 ||
			a >= 224 ||
			(a === 169 && b === 254) ||
			(a === 172 && b >= 16 && b <= 31) ||
			(a === 192 && b === 168) ||
			(a === 192 && b === 88 && c === 99) ||
			(a === 100 && b >= 64 && b <= 127) ||
			(a === 192 && b === 0 && (c === 0 || c === 2)) ||
			(a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
			(a === 203 && b === 0 && c === 113)
		);
	}
	if (family === 6) {
		let value: string;
		try {
			// URL canonicalizes expanded and IPv4-mapped IPv6 forms before prefix checks.
			value = new URL(`http://[${address}]/`).hostname.slice(1, -1).toLowerCase();
		} catch {
			return false;
		}
		if (value.startsWith('::ffff:')) {
			const mapped = value.split(':').filter(Boolean);
			const high = parseInt(mapped.at(-2) || '0', 16);
			const low = parseInt(mapped.at(-1) || '0', 16);
			return ipIsPublic(`${high >>> 8}.${high & 255}.${low >>> 8}.${low & 255}`);
		}
		const groups = value.split(':');
		const first = parseInt(groups[0] || '0', 16);
		const second = parseInt(groups[1] || '0', 16);
		const third = parseInt(groups[2] || '0', 16);
		const globallyReachableIetfAllocations =
			value === '2001:1::1' ||
			value === '2001:1::2' ||
			value === '2001:1::3' ||
			second === 0x0003 ||
			(second === 0x0004 && third === 0x0112) ||
			(second & 0xfff0) === 0x0020 ||
			(second & 0xfff0) === 0x0030;
		if (first === 0x2001 && second < 0x0200) {
			if (!globallyReachableIetfAllocations) return false; // 2001::/23 except specific reachable allocations
		}
		if (first === 0x2001 && second === 0x0002 && third === 0x0000) return false; // 2001:2::/48 benchmarking
		if (first === 0x3fff && (second & 0xf000) === 0) return false; // 3fff::/20 documentation
		return (
			first >= 0x2000 &&
			first <= 0x3fff &&
			!value.startsWith('2001:db8:') &&
			!value.startsWith('2001:0:') &&
			!value.startsWith('2002:')
		);
	}
	return false;
}
type LookupAddress = { address: string; family: number };
export async function validateWebhookTarget(
	value: string,
	resolver: (host: string) => Promise<LookupAddress[]> = async (host) =>
		dnsLookup(host, { all: true, verbatim: true })
) {
	let target: URL;
	try {
		target = new URL(value);
	} catch {
		throw new AdminError('Enter a valid public HTTPS URL.', 422);
	}
	const host = target.hostname.toLowerCase().replace(/^\[|\]$/g, '');
	if (
		target.protocol !== 'https:' ||
		target.username ||
		target.password ||
		(target.port && target.port !== '443') ||
		target.hash ||
		!host ||
		host === 'localhost' ||
		host.endsWith('.localhost') ||
		host.endsWith('.local') ||
		host.endsWith('.internal') ||
		host.endsWith('.test') ||
		host.endsWith('.example') ||
		host.endsWith('.invalid') ||
		isIP(host)
	)
		throw new AdminError('Webhook destinations must use a public HTTPS hostname on port 443.', 422);
	let addresses: LookupAddress[];
	try {
		addresses = await resolver(host);
	} catch {
		throw new AdminError('Webhook hostname could not be resolved to a public address.', 422);
	}
	if (!addresses.length || addresses.some((item) => !ipIsPublic(item.address)))
		throw new AdminError(
			'Webhook hostname resolves to a private or reserved network address.',
			422
		);
	return { target, address: addresses[0].address, family: addresses[0].family };
}

function webhookVault() {
	try {
		return credentialVaultFromEnvironment();
	} catch {
		throw new AdminError('Credential encryption is not configured for signed webhooks.', 503);
	}
}
export async function createWebhookEndpoint(session: TenantSession, input: unknown) {
	const data = endpointSchema.parse(input);
	await authorizeManager(session);
	await validateWebhookTarget(data.url);
	const id = randomUUID(),
		secret = randomBytes(32).toString('base64url');
	return tenantTransaction(session, managerRoles, async (client, tenant) => {
		const tenantEnvelope = webhookVault().encrypt(
			{ tenantId: tenant.id, provider: 'webhook', credentialId: id },
			secret
		);
		await client.query(
			'INSERT INTO webhook_endpoints(tenant_id,id,label,target_url,secret_envelope,events,approved_by,approved_at,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,now(),$7)',
			[tenant.id, id, data.label, data.url, tenantEnvelope, data.events, session.userId]
		);
		await serviceAudit(
			client,
			tenant.id,
			session.userId,
			'webhook_endpoint.create',
			'webhook_endpoints',
			id,
			{ events: data.events, approved: true }
		);
		return {
			secret,
			endpoint: {
				id,
				label: data.label,
				url: data.url,
				events: data.events,
				enabled: true,
				createdAt: new Date().toISOString()
			}
		};
	});
}

export async function revokeWebhookEndpoint(session: TenantSession, idInput: string) {
	const id = z.string().uuid().parse(idInput);
	await authorizeManager(session);
	return tenantTransaction(session, managerRoles, async (client, tenant) => {
		const result = await client.query(
			'UPDATE webhook_endpoints SET enabled=false,revoked_at=coalesce(revoked_at,now()) WHERE tenant_id=$1 AND id=$2 RETURNING id',
			[tenant.id, id]
		);
		if (!result.rowCount)
			throw new AdminError('Webhook endpoint not found in this workspace.', 404);
		await serviceAudit(
			client,
			tenant.id,
			session.userId,
			'webhook_endpoint.revoke',
			'webhook_endpoints',
			id
		);
		return { revoked: true };
	});
}

export async function getRetentionPolicy(session: TenantSession) {
	await authorizeManager(session);
	return tenantTransaction(session, managerRoles, async (client, tenant) => {
		const result = await client.query(
			'SELECT enabled,"ai_retention_days" AS "aiRetentionDays",webhook_delivery_retention_days AS "webhookDeliveryRetentionDays",updated_at AS "updatedAt" FROM tenant_retention_policies WHERE tenant_id=$1',
			[tenant.id]
		);
		return {
			policy: result.rows[0] || {
				enabled: false,
				aiRetentionDays: 365,
				webhookDeliveryRetentionDays: 365,
				updatedAt: null
			}
		};
	});
}
export async function setRetentionPolicy(session: TenantSession, input: unknown) {
	const data = retentionSchema.parse(input);
	await authorizeManager(session);
	return tenantTransaction(session, managerRoles, async (client, tenant) => {
		const result = await client.query(
			`INSERT INTO tenant_retention_policies(tenant_id,enabled,ai_retention_days,webhook_delivery_retention_days,updated_by)
		VALUES($1,$2,$3,$4,$5) ON CONFLICT(tenant_id) DO UPDATE SET enabled=excluded.enabled,ai_retention_days=excluded.ai_retention_days,webhook_delivery_retention_days=excluded.webhook_delivery_retention_days,updated_by=excluded.updated_by,updated_at=now()
		RETURNING enabled,"ai_retention_days" AS "aiRetentionDays",webhook_delivery_retention_days AS "webhookDeliveryRetentionDays",updated_at AS "updatedAt"`,
			[
				tenant.id,
				data.enabled,
				data.aiRetentionDays,
				data.webhookDeliveryRetentionDays,
				session.userId
			]
		);
		await serviceAudit(
			client,
			tenant.id,
			session.userId,
			'retention_policy.update',
			'tenant_retention_policies',
			tenant.id,
			{
				enabled: data.enabled,
				aiRetentionDays: data.aiRetentionDays,
				webhookDeliveryRetentionDays: data.webhookDeliveryRetentionDays
			}
		);
		nextTenantRetentionCheck.delete(tenant.id);
		return { policy: result.rows[0] };
	});
}

/** Safe, opt-in daily cleanup. It only removes expired AI workspace data and old webhook logs. */
const nextTenantRetentionCheck = new Map<string, number>();
export async function runTenantRetentionMaintenance(pool: Pool, tenantId: string) {
	const now = Date.now();
	if ((nextTenantRetentionCheck.get(tenantId) || 0) > now) return { ran: false };
	const client = await pool.connect();
	try {
		await client.query('BEGIN');
		await client.query("SELECT set_config('app.tenant_id',$1,true)", [tenantId]);
		const policy = await client.query(
			`UPDATE tenant_retention_policies SET last_run_at=now() WHERE tenant_id=$1 AND enabled=true
		AND (last_run_at IS NULL OR last_run_at < now()-interval '24 hours')
		RETURNING ai_retention_days AS "aiRetentionDays",webhook_delivery_retention_days AS "webhookDeliveryRetentionDays"`,
			[tenantId]
		);
		if (!policy.rowCount) {
			await client.query('COMMIT');
			nextTenantRetentionCheck.set(tenantId, now + 86_400_000);
			return { ran: false };
		}
		const { aiRetentionDays, webhookDeliveryRetentionDays } = policy.rows[0];
		await client.query(
			'DELETE FROM ai_action_confirmations WHERE tenant_id=$1 AND expires_at<now()',
			[tenantId]
		);
		await client.query(
			'DELETE FROM ai_tool_audit WHERE tenant_id=$1 AND created_at < now()-make_interval(days=>$2)',
			[tenantId, aiRetentionDays]
		);
		await client.query(
			'DELETE FROM ai_messages WHERE tenant_id=$1 AND created_at < now()-make_interval(days=>$2)',
			[tenantId, aiRetentionDays]
		);
		await client.query(
			'DELETE FROM ai_conversations WHERE tenant_id=$1 AND updated_at < now()-make_interval(days=>$2)',
			[tenantId, aiRetentionDays]
		);
		await client.query(
			`DELETE FROM webhook_deliveries WHERE tenant_id=$1 AND status IN ('delivered','failed')
		AND created_at < now()-make_interval(days=>$2)`,
			[tenantId, webhookDeliveryRetentionDays]
		);
		await client.query('COMMIT');
		nextTenantRetentionCheck.set(tenantId, now + 86_400_000);
		return { ran: true };
	} catch (error) {
		await client.query('ROLLBACK').catch(() => undefined);
		throw error;
	} finally {
		client.release();
	}
}

export async function dispatchWebhookSubscriptions(
	event: { id: string; tenantId: string; eventType: string; payload: unknown },
	pool: Pool = getPool()
) {
	if (!webhookEventTypes.includes(event.eventType as (typeof webhookEventTypes)[number])) return;
	const payload =
		event.payload && typeof event.payload === 'object'
			? (event.payload as Record<string, unknown>)
			: {};
	const requestedEndpointId =
		event.eventType === 'automation.action' && typeof payload.endpointId === 'string'
			? payload.endpointId
			: null;
	if (
		event.eventType === 'automation.action' &&
		(!requestedEndpointId ||
			!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
				requestedEndpointId
			))
	)
		return;
	const safe = {
		eventId: event.id,
		tenantId: event.tenantId,
		type: event.eventType,
		occurredAt: new Date().toISOString(),
		resource: typeof payload.resource === 'string' ? payload.resource : undefined,
		recordId: typeof payload.recordId === 'string' ? payload.recordId : undefined,
		contactId: typeof payload.contactId === 'string' ? payload.contactId : undefined,
		campaignId: typeof payload.campaignId === 'string' ? payload.campaignId : undefined
	};
	const client = await pool.connect();
	try {
		await client.query('BEGIN');
		await client.query("SELECT set_config('app.tenant_id',$1,true)", [event.tenantId]);
		const endpoints = await client.query(
			`SELECT id FROM webhook_endpoints WHERE tenant_id=$1 AND enabled=true AND revoked_at IS NULL AND $2=ANY(events)
				AND ($3::text IS NULL OR id::text=$3) AND ($2<>'automation.action' OR approved_at IS NOT NULL)`,
			[event.tenantId, event.eventType, requestedEndpointId]
		);
		for (const endpoint of endpoints.rows) {
			const deliveryId = randomUUID();
			const inserted = await client.query(
				'INSERT INTO webhook_deliveries(tenant_id,id,endpoint_id,event_type,event_payload) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING id',
				[
					event.tenantId,
					deliveryId,
					endpoint.id,
					event.eventType,
					event.eventType === 'automation.action' ? { ...safe, endpointId: endpoint.id } : safe
				]
			);
			if (!inserted.rowCount) continue;
			await client.query(
				"INSERT INTO outbox_events(tenant_id,event_type,payload,idempotency_key) VALUES($1,'webhook.deliver',$2,$3) ON CONFLICT(idempotency_key) DO NOTHING",
				[event.tenantId, { deliveryId }, `webhook:${deliveryId}`]
			);
		}
		await client.query('COMMIT');
	} catch (error) {
		await client.query('ROLLBACK').catch(() => undefined);
		throw error;
	} finally {
		client.release();
	}
}

async function requestWebhook(
	url: URL,
	address: string,
	family: number,
	body: string,
	signature: string,
	deliveryId: string
) {
	return new Promise<number>((resolve, reject) => {
		const request = httpsRequest(
			url,
			{
				method: 'POST',
				servername: url.hostname,
				lookup: ((
					_hostname: string,
					_options: unknown,
					callback: (error: NodeJS.ErrnoException | null, address: string, family: number) => void
				) => callback(null, address, family)) as never,
				timeout: 8000,
				headers: {
					'content-type': 'application/json',
					'user-agent': 'GiveLoom-Webhooks/1.0',
					'x-giveloom-delivery': deliveryId,
					'x-giveloom-signature': signature,
					'content-length': Buffer.byteLength(body)
				}
			} as never,
			(response) => {
				let bytes = 0;
				response.on('data', (chunk) => {
					bytes += Buffer.byteLength(chunk);
					if (bytes > 2048)
						response.destroy(new Error('Webhook response exceeded the size limit.'));
				});
				response.on('end', () => {
					const status = response.statusCode || 0;
					if (status >= 200 && status < 300) resolve(status);
					else
						reject(
							new Error(
								status >= 300 && status < 400
									? 'Webhook redirects are disabled.'
									: `Webhook endpoint returned HTTP ${status}.`
							)
						);
				});
			}
		);
		request.on('timeout', () => request.destroy(new Error('Webhook request timed out.')));
		request.on('error', reject);
		request.end(body);
	});
}

export async function handleWebhookDeliveryOutboxEvent(
	event: { tenantId: string; payload: unknown },
	pool: Pool = getPool()
) {
	const deliveryId = z
		.string()
		.uuid()
		.parse((event.payload as { deliveryId?: unknown })?.deliveryId);
	const metadata = await (async () => {
		const client = await pool.connect();
		try {
			await client.query('BEGIN');
			await client.query("SELECT set_config('app.tenant_id',$1,true)", [event.tenantId]);
			const result = await client.query(
				`SELECT d.id,d.status,d.attempts,d.event_type AS "eventType",d.event_payload AS "eventPayload",e.id AS "endpointId",e.target_url AS "targetUrl",e.secret_envelope AS "secretEnvelope",e.enabled,e.revoked_at AS "revokedAt" FROM webhook_deliveries d JOIN webhook_endpoints e ON e.tenant_id=d.tenant_id AND e.id=d.endpoint_id WHERE d.tenant_id=$1 AND d.id=$2 FOR UPDATE OF d`,
				[event.tenantId, deliveryId]
			);
			await client.query('COMMIT');
			return result.rows[0];
		} catch (error) {
			await client.query('ROLLBACK').catch(() => undefined);
			throw error;
		} finally {
			client.release();
		}
	})();
	if (!metadata || metadata.status === 'delivered' || metadata.status === 'failed') return;
	if (!metadata.enabled || metadata.revokedAt) {
		await updateWebhookDelivery(pool, event.tenantId, deliveryId, {
			status: 'failed',
			error: 'Endpoint was revoked before delivery.'
		});
		return;
	}
	const attempt = Number(metadata.attempts) + 1;
	const fail = async (error: unknown) => {
		const message = (error instanceof Error ? error.message : 'Delivery failed')
			.replace(/\b(?:sk|rk|pk|whsec)_[A-Za-z0-9_-]+\b/gi, '[redacted credential]')
			.slice(0, 400);
		const terminal = attempt >= 8;
		const client = await pool.connect();
		try {
			await client.query('BEGIN');
			await client.query("SELECT set_config('app.tenant_id',$1,true)", [event.tenantId]);
			await client.query(
				'UPDATE webhook_deliveries SET attempts=$3,status=$4,last_error=$5 WHERE tenant_id=$1 AND id=$2',
				[event.tenantId, deliveryId, attempt, terminal ? 'failed' : 'queued', message]
			);
			await client.query(
				'INSERT INTO webhook_delivery_attempts(tenant_id,delivery_id,attempt_number,error,finished_at) VALUES($1,$2,$3,$4,now()) ON CONFLICT(tenant_id,delivery_id,attempt_number) DO UPDATE SET error=excluded.error,finished_at=excluded.finished_at',
				[event.tenantId, deliveryId, attempt, message]
			);
			await client.query('COMMIT');
		} catch (e) {
			await client.query('ROLLBACK').catch(() => undefined);
			throw e;
		} finally {
			client.release();
		}
		if (!terminal) throw error instanceof Error ? error : new Error(message);
	};
	try {
		const { target, address, family } = await validateWebhookTarget(metadata.targetUrl);
		const secret = webhookVault().decrypt(
			{ tenantId: event.tenantId, provider: 'webhook', credentialId: metadata.endpointId },
			metadata.secretEnvelope
		);
		const body = JSON.stringify(metadata.eventPayload);
		const timestamp = Math.floor(Date.now() / 1000);
		const digest = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
		const responseStatus = await requestWebhook(
			target,
			address,
			family,
			body,
			`t=${timestamp},v1=${digest}`,
			deliveryId
		);
		const client = await pool.connect();
		try {
			await client.query('BEGIN');
			await client.query("SELECT set_config('app.tenant_id',$1,true)", [event.tenantId]);
			await client.query(
				"UPDATE webhook_deliveries SET status='delivered',attempts=$3,response_status=$4,last_error=NULL,delivered_at=now() WHERE tenant_id=$1 AND id=$2",
				[event.tenantId, deliveryId, attempt, responseStatus]
			);
			await client.query(
				'INSERT INTO webhook_delivery_attempts(tenant_id,delivery_id,attempt_number,response_status,finished_at) VALUES($1,$2,$3,$4,now()) ON CONFLICT(tenant_id,delivery_id,attempt_number) DO NOTHING',
				[event.tenantId, deliveryId, attempt, responseStatus]
			);
			await client.query('COMMIT');
		} catch (error) {
			await client.query('ROLLBACK').catch(() => undefined);
			throw error;
		} finally {
			client.release();
		}
	} catch (error) {
		await fail(error);
	}
}
async function updateWebhookDelivery(
	pool: Pool,
	tenantId: string,
	id: string,
	update: { status: 'failed'; error: string }
) {
	const client = await pool.connect();
	try {
		await client.query('BEGIN');
		await client.query("SELECT set_config('app.tenant_id',$1,true)", [tenantId]);
		await client.query(
			'UPDATE webhook_deliveries SET status=$3,last_error=$4 WHERE tenant_id=$1 AND id=$2',
			[tenantId, id, update.status, update.error]
		);
		await client.query('COMMIT');
	} catch (error) {
		await client.query('ROLLBACK').catch(() => undefined);
		throw error;
	} finally {
		client.release();
	}
}

export function adminResponseError(error: unknown) {
	if (error instanceof AdminError) return { status: error.status, error: error.message };
	if (error instanceof z.ZodError)
		return { status: 422, error: 'The administration request is invalid.' };
	const code = String((error as { code?: unknown })?.code || '');
	return {
		status: code === '23505' ? 409 : 503,
		error: 'The administration service is temporarily unavailable.'
	};
}

export async function getPlatformHealth(session: TenantSession | null) {
	if (!session || session.demo)
		throw new AdminError('Sign in as a configured platform operator.', 401);
	const allowed = (process.env.PLATFORM_ADMIN_EMAILS || env.PLATFORM_ADMIN_EMAILS || '')
		.split(',')
		.map((value) => value.trim().toLowerCase())
		.filter(Boolean);
	if (!allowed.length) throw new AdminError('Platform administration is not configured.', 503);
	const pool = getPool();
	const operator = await workspaceFromPostgres(session.tenantSlug, session.userId, session.role);
	if (!operator || !allowed.includes(operator.user.email.toLowerCase()))
		throw new AdminError('Platform operator access is required.', 403);
	const tenantRows = await pool.query('SELECT id,slug FROM tenants ORDER BY id');
	const health = {
		databaseConnections: Number(
			(
				await pool.query(
					'SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database()'
				)
			).rows[0].count
		),
		pendingOutbox: 0,
		failedOutbox: 0,
		failedWebhooks: 0
	};
	const tenants = [] as Array<{
		id: string;
		slug: string;
		pendingOutbox: number;
		failedOutbox: number;
		failedWebhooks: number;
	}>;
	for (const row of tenantRows.rows) {
		const client = await pool.connect();
		try {
			await client.query('BEGIN');
			await client.query("SELECT set_config('app.tenant_id',$1,true)", [row.id]);
			const counts = await client.query(
				`SELECT (SELECT count(*)::int FROM outbox_events WHERE tenant_id=$1 AND processed_at IS NULL) AS pending,
		(SELECT count(*)::int FROM outbox_events WHERE tenant_id=$1 AND last_error IS NOT NULL) AS failed,
		(SELECT count(*)::int FROM webhook_deliveries WHERE tenant_id=$1 AND status='failed') AS webhooks`,
				[row.id]
			);
			await client.query('COMMIT');
			const item = {
				id: row.id,
				slug: row.slug,
				pendingOutbox: counts.rows[0].pending,
				failedOutbox: counts.rows[0].failed,
				failedWebhooks: counts.rows[0].webhooks
			};
			tenants.push(item);
			health.pendingOutbox += item.pendingOutbox;
			health.failedOutbox += item.failedOutbox;
			health.failedWebhooks += item.failedWebhooks;
		} catch (error) {
			await client.query('ROLLBACK').catch(() => undefined);
			throw error;
		} finally {
			client.release();
		}
	}
	return {
		tenantCount: tenantRows.rowCount || 0,
		health,
		tenants,
		snapshotAt: new Date().toISOString()
	};
}

export async function listPlatformTenants(session: TenantSession | null) {
	await getPlatformHealth(session);
	const pool = getPool();
	const tenantRows = await pool.query(
		'SELECT id,slug,legal_name AS "legalName",suspended_at AS "suspendedAt",suspension_reason AS "suspensionReason",plan_label AS "planLabel",subscription_status AS "subscriptionStatus",subscription_updated_at AS "subscriptionUpdatedAt",created_at AS "createdAt" FROM tenants ORDER BY created_at DESC LIMIT 500'
	);
	const rows = [];
	for (const tenant of tenantRows.rows) {
		const client = await pool.connect();
		try {
			await client.query('BEGIN');
			await client.query("SELECT set_config('app.tenant_id',$1,true)", [tenant.id]);
			const counts = await client.query(
				`SELECT (SELECT count(*)::int FROM memberships WHERE tenant_id=$1 AND status='active') AS "activeMembers",
		(SELECT count(*)::int FROM contacts WHERE tenant_id=$1 AND archived_at IS NULL) AS "contactCount",
		(SELECT count(*)::int FROM outbox_events WHERE tenant_id=$1 AND processed_at IS NULL) AS "pendingOutbox"`,
				[tenant.id]
			);
			await client.query('COMMIT');
			rows.push({ ...tenant, ...counts.rows[0] });
		} catch (error) {
			await client.query('ROLLBACK').catch(() => undefined);
			throw error;
		} finally {
			client.release();
		}
	}
	return rows;
}
