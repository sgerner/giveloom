import { createHash } from 'node:crypto';
import { resolveCname, resolveTxt } from 'node:dns/promises';
import { env } from '$env/dynamic/private';
import { OpenAIResponsesProvider } from '$lib/providers/ai';
import { SesEmailProvider } from '$lib/providers/ses';
import { credentialVaultFromEnvironment } from '$lib/providers/vault.server';
import { getPool, workspaceFromPostgres } from './database';

export type IntegrationProvider = 'openai' | 'ses';
type IntegrationSession = { userId: string; tenantSlug: string; role: string };
const allowedAdminRoles = new Set(['owner', 'admin']);
const aiLimits = {
	requestsPerMinute: 5,
	requestsPer24Hours: 100,
	inputCharsPer24Hours: 100_000,
	maxInputCharsPerRequest: 8_000,
	maxOutputTokens: 512
};

export function assertAiBudget(
	counts: { lastMinute: number; lastDay: number; charsLastDay: number },
	nextInputChars: number
) {
	if (counts.lastMinute >= aiLimits.requestsPerMinute)
		throw new IntegrationError('AI request rate limit reached. Try again shortly.', 429);
	if (
		counts.lastDay >= aiLimits.requestsPer24Hours ||
		counts.charsLastDay + nextInputChars > aiLimits.inputCharsPer24Hours
	)
		throw new IntegrationError('Tenant AI daily budget reached.', 429);
}

export class IntegrationError extends Error {
	constructor(
		message: string,
		readonly status: number
	) {
		super(message);
		this.name = 'IntegrationError';
	}
}

async function authorize(session: IntegrationSession) {
	if (!env.DATABASE_URL)
		throw new IntegrationError('Persistent integration storage is not configured.', 503);
	const workspace = await workspaceFromPostgres(session.tenantSlug, session.userId, session.role);
	if (!workspace) throw new IntegrationError('The active tenant membership is unavailable.', 403);
	if (!allowedAdminRoles.has(workspace.user.role))
		throw new IntegrationError(
			'Only tenant owners and administrators can manage integrations.',
			403
		);
	return workspace;
}

async function withTenant<T>(
	tenantId: string,
	userId: string,
	callback: (client: import('pg').PoolClient) => Promise<T>
): Promise<T> {
	const client = await getPool().connect();
	try {
		await client.query('BEGIN');
		await client.query("SELECT set_config('app.tenant_id',$1,true)", [tenantId]);
		const member = await client.query(
			"SELECT 1 FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.tenant_id=$1 AND m.user_id=$2 AND m.status='active' AND u.disabled_at IS NULL AND m.role IN ('owner','admin')",
			[tenantId, userId]
		);
		if (!member.rowCount)
			throw new IntegrationError(
				'Only active tenant owners and administrators may access provider credentials.',
				403
			);
		const result = await callback(client);
		await client.query('COMMIT');
		return result;
	} catch (error) {
		await client.query('ROLLBACK').catch(() => undefined);
		throw error;
	} finally {
		client.release();
	}
}

function vault() {
	try {
		return credentialVaultFromEnvironment();
	} catch {
		throw new IntegrationError('Credential encryption is not configured.', 503);
	}
}

function parseEnvelope<T>(tenantId: string, provider: IntegrationProvider, envelope: string): T {
	try {
		return JSON.parse(
			vault().decrypt({ tenantId, provider, credentialId: 'primary' }, envelope)
		) as T;
	} catch {
		throw new IntegrationError('Stored provider credentials cannot be decrypted.', 503);
	}
}

function publicStatus(
	provider: IntegrationProvider,
	row?: { enabled: boolean; metadata: Record<string, unknown> }
) {
	if (!row)
		return { provider, configured: false, enabled: false, status: 'not_configured', metadata: {} };
	const enabled = row.enabled;
	return {
		provider,
		configured: true,
		enabled,
		status:
			provider === 'ses'
				? enabled
					? 'enabled_verified'
					: 'configured_unverified'
				: enabled
					? 'enabled_unverified'
					: 'disabled',
		metadata: row.metadata
	};
}

/** Return only safe, non-secret status fields for the current session tenant. */
export async function getIntegrationStatuses(session: IntegrationSession) {
	const workspace = await authorize(session);
	const rows = await withTenant(
		workspace.tenant.id,
		session.userId,
		async (client) =>
			(
				await client.query(
					'SELECT provider,enabled,metadata FROM integration_configs WHERE tenant_id=$1 AND credential_id=$2',
					[workspace.tenant.id, 'primary']
				)
			).rows as Array<{
				provider: IntegrationProvider;
				enabled: boolean;
				metadata: Record<string, unknown>;
			}>
	);
	const byProvider = new Map(rows.map((row) => [row.provider, row]));
	return {
		providers: (['openai', 'ses'] as const).map((provider) =>
			publicStatus(provider, byProvider.get(provider))
		)
	};
}

async function readTxt(name: string) {
	try {
		return { status: 'found', records: (await resolveTxt(name)).map((record) => record.join('')) };
	} catch {
		return { status: 'missing_or_unavailable', records: [] as string[] };
	}
}

/** Read-only sender, domain-authentication, sandbox and quota diagnostics. Never returns credentials. */
export async function diagnoseSesIntegration(session: IntegrationSession) {
	const workspace = await authorize(session);
	const stored = await withTenant(workspace.tenant.id, session.userId, async (client) => {
		const result = await client.query(
			"SELECT enabled,credential_envelope FROM integration_configs WHERE tenant_id=$1 AND provider='ses' AND credential_id='primary'",
			[workspace.tenant.id]
		);
		return result.rows[0] as { enabled: boolean; credential_envelope: string } | undefined;
	});
	if (!stored)
		return {
			configured: false,
			enabled: false,
			region: null,
			sender: null,
			domain: null,
			dns: null,
			quota: null
		};
	const config = parseEnvelope<{
		region: string;
		fromAddress: string;
		accessKeyId: string;
		secretAccessKey: string;
		sessionToken?: string;
	}>(workspace.tenant.id, 'ses', stored.credential_envelope);
	const domain = config.fromAddress.split('@').at(-1)?.toLowerCase() ?? '';
	const ses = new SesEmailProvider({
		region: config.region,
		fromAddress: config.fromAddress,
		credentials: {
			accessKeyId: config.accessKeyId,
			secretAccessKey: config.secretAccessKey,
			...(config.sessionToken ? { sessionToken: config.sessionToken } : {})
		}
	});
	try {
		const [sender, domainIdentity, quota] = await Promise.all([
			ses.verifySenderIdentity(config.fromAddress),
			ses.inspectIdentity(domain),
			ses.getSendingQuota()
		]);
		const [spf, dmarc] = await Promise.all([readTxt(domain), readTxt(`_dmarc.${domain}`)]);
		const dkim = await Promise.all(
			domainIdentity.dkimTokens.map(async (token) => {
				const name = `${token}._domainkey.${domain}`;
				try {
					const targets = await resolveCname(name);
					return {
						name,
						status: targets.some(
							(target) => target.toLowerCase().replace(/\.$/, '') === `${token}.dkim.amazonses.com`
						)
							? 'verified'
							: 'mismatch'
					};
				} catch {
					return { name, status: 'missing_or_unavailable' };
				}
			})
		);
		return {
			configured: true,
			enabled: stored.enabled,
			region: config.region,
			sender: { address: config.fromAddress, verifiedForSending: sender.verifiedForSending },
			domain: {
				name: domain,
				verified:
					domainIdentity.verifiedForSending || domainIdentity.verificationStatus === 'SUCCESS',
				verificationStatus: domainIdentity.verificationStatus,
				dkimStatus: domainIdentity.dkimStatus,
				dkimEnabled: domainIdentity.dkimEnabled,
				mailFromDomain: domainIdentity.mailFromDomain || null,
				mailFromStatus: domainIdentity.mailFromStatus
			},
			dns: {
				spf: { ...spf, configured: spf.records.some((record) => /^v=spf1(?:\s|$)/i.test(record)) },
				dmarc: {
					...dmarc,
					configured: dmarc.records.some((record) => /^v=dmarc1(?:\s|$)/i.test(record))
				},
				dkim
			},
			quota: {
				sandbox: !quota.productionAccessEnabled,
				max24HourSend: quota.max24HourSend,
				sentLast24Hours: quota.sentLast24Hours,
				remaining24Hour: Math.max(0, quota.max24HourSend - quota.sentLast24Hours),
				maxSendRate: quota.maxSendRate
			}
		};
	} catch (error) {
		throw new IntegrationError(
			error instanceof Error ? error.message : 'SES diagnostics are temporarily unavailable.',
			503
		);
	}
}

export async function saveIntegration(
	session: IntegrationSession,
	provider: IntegrationProvider,
	config: Record<string, unknown>,
	enabled: boolean
) {
	const workspace = await authorize(session);
	const credentialEnvelope = vault().encrypt(
		{ tenantId: workspace.tenant.id, provider, credentialId: 'primary' },
		JSON.stringify(config)
	);
	const metadata =
		provider === 'openai'
			? { model: String(config.model) }
			: {
					region: String(config.region),
					senderDomain: String(config.fromAddress).split('@').at(-1)?.toLowerCase() ?? ''
				};
	return withTenant(workspace.tenant.id, session.userId, async (client) => {
		await client.query(
			`INSERT INTO integration_configs(tenant_id,provider,credential_id,enabled,credential_envelope,metadata,updated_by)
			VALUES($1,$2,'primary',$3,$4,$5,$6)
			ON CONFLICT(tenant_id,provider,credential_id) DO UPDATE SET enabled=EXCLUDED.enabled,credential_envelope=EXCLUDED.credential_envelope,metadata=EXCLUDED.metadata,updated_by=EXCLUDED.updated_by,updated_at=now()`,
			[workspace.tenant.id, provider, enabled, credentialEnvelope, metadata, session.userId]
		);
		await client.query(
			'INSERT INTO audit_log(tenant_id,actor_id,action,resource,details) VALUES($1,$2,$3,$4,$5)',
			[
				workspace.tenant.id,
				session.userId,
				'integration.configured',
				'integrations',
				{ provider, enabled }
			]
		);
		return publicStatus(provider, { enabled, metadata });
	});
}

export async function removeIntegration(
	session: IntegrationSession,
	provider: IntegrationProvider
) {
	const workspace = await authorize(session);
	return withTenant(workspace.tenant.id, session.userId, async (client) => {
		await client.query(
			'DELETE FROM integration_configs WHERE tenant_id=$1 AND provider=$2 AND credential_id=$3',
			[workspace.tenant.id, provider, 'primary']
		);
		await client.query(
			'INSERT INTO audit_log(tenant_id,actor_id,action,resource,details) VALUES($1,$2,$3,$4,$5)',
			[workspace.tenant.id, session.userId, 'integration.removed', 'integrations', { provider }]
		);
		return { provider, configured: false, enabled: false, status: 'not_configured', metadata: {} };
	});
}

type OpenAICredential = { apiKey: string; model: string };

async function reserveAiUsage(
	tenantId: string,
	userId: string,
	model: string,
	promptHash: string,
	inputChars: number
) {
	return withTenant(tenantId, userId, async (client) => {
		await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
			`giveloom-ai-budget:${tenantId}`
		]);
		const counts = await client.query(
			`SELECT count(*) FILTER (WHERE created_at >= now()-interval '1 minute')::int AS last_minute,
			count(*)::int AS last_day, coalesce(sum(input_chars),0)::bigint AS chars_last_day
			FROM ai_usage WHERE tenant_id=$1 AND created_at >= now()-interval '24 hours'`,
			[tenantId]
		);
		const row = counts.rows[0] as { last_minute: number; last_day: number; chars_last_day: string };
		assertAiBudget(
			{
				lastMinute: row.last_minute,
				lastDay: row.last_day,
				charsLastDay: Number(row.chars_last_day)
			},
			inputChars
		);
		const result = await client.query(
			`INSERT INTO ai_usage(tenant_id,user_id,provider,model,prompt_hash,input_chars,status)
			VALUES($1,$2,'openai',$3,$4,$5,'reserved') RETURNING id`,
			[tenantId, userId, model, promptHash, inputChars]
		);
		return result.rows[0].id as string;
	});
}

async function finishAiUsage(
	tenantId: string,
	userId: string,
	id: string,
	status: 'succeeded' | 'failed',
	usage?: { inputTokens?: number; outputTokens?: number }
) {
	await withTenant(tenantId, userId, async (client) => {
		await client.query(
			"UPDATE ai_usage SET status=$4,input_tokens=$5,output_tokens=$6,completed_at=now() WHERE tenant_id=$1 AND user_id=$2 AND id=$3 AND status='reserved'",
			[tenantId, userId, id, status, usage?.inputTokens ?? null, usage?.outputTokens ?? null]
		);
	});
}

/** Runs an aggregate-only contact summary; no names, email addresses, or records go to the model. */
export async function summarizeTenantContacts(session: IntegrationSession, question: string) {
	const workspace = await authorize(session);
	const tenantId = workspace.tenant.id;
	const config = await withTenant(tenantId, session.userId, async (client) => {
		const saved = await client.query(
			"SELECT credential_envelope FROM integration_configs WHERE tenant_id=$1 AND provider='openai' AND credential_id=$2 AND enabled=true",
			[tenantId, 'primary']
		);
		if (!saved.rowCount)
			throw new IntegrationError(
				'Enable an OpenAI integration before requesting an AI summary.',
				409
			);
		const stages = await client.query(
			'SELECT stage,count(*)::int AS count FROM contacts WHERE tenant_id=$1 AND archived_at IS NULL GROUP BY stage ORDER BY stage',
			[tenantId]
		);
		return {
			envelope: saved.rows[0].credential_envelope as string,
			stages: stages.rows as Array<{ stage: string; count: number }>
		};
	});
	const credentials = parseEnvelope<OpenAICredential>(tenantId, 'openai', config.envelope);
	if (!credentials.apiKey || !credentials.model)
		throw new IntegrationError('Stored OpenAI configuration is incomplete.', 503);
	const summary = {
		contactCount: config.stages.reduce((sum, item) => sum + item.count, 0),
		contactsByStage: Object.fromEntries(config.stages.map((item) => [item.stage, item.count]))
	};
	const system =
		'You are a nonprofit CRM assistant. Answer only from the aggregate contact statistics provided. Do not infer or invent individual donor details. Do not request or propose write actions. If the question needs data not provided, say so.';
	const user = JSON.stringify({ aggregate: summary, question });
	const inputChars = system.length + user.length;
	if (inputChars > aiLimits.maxInputCharsPerRequest)
		throw new IntegrationError('AI request exceeds the per-request input budget.', 422);
	const promptHash = createHash('sha256').update(JSON.stringify({ system, user })).digest('hex');
	const usageId = await reserveAiUsage(
		tenantId,
		session.userId,
		credentials.model,
		promptHash,
		inputChars
	);
	try {
		const response = await new OpenAIResponsesProvider({
			maxInputCharacters: aiLimits.maxInputCharsPerRequest,
			maxOutputTokens: aiLimits.maxOutputTokens
		}).complete({
			tenantId,
			apiKey: credentials.apiKey,
			model: credentials.model,
			system,
			user
		});
		await finishAiUsage(tenantId, session.userId, usageId, 'succeeded', {
			inputTokens: response.inputTokens,
			outputTokens: response.outputTokens
		});
		return {
			answer: response.text,
			model: response.model,
			usage: {
				inputTokens: response.inputTokens ?? null,
				outputTokens: response.outputTokens ?? null,
				promptHash
			}
		};
	} catch (error) {
		await finishAiUsage(tenantId, session.userId, usageId, 'failed').catch(() => undefined);
		if (error instanceof IntegrationError) throw error;
		throw new IntegrationError('The AI provider request failed. No CRM changes were made.', 502);
	}
}

export function integrationDatabaseReady() {
	return Boolean(env.DATABASE_URL);
}
export const providerRateLimits = aiLimits;
