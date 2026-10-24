import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { env } from '$env/dynamic/private';
import { canViewGraphEvidence } from './intelligence';
import {
	assertRoleCanMutate,
	safeMinorUnits,
	redactWorkspaceValue,
	type Resource,
	type Workspace
} from './domain';
import { collectionNames } from './demo-data';

let pool: Pool | undefined;
export function getPool() {
	if (!env.DATABASE_URL) throw new Error('DATABASE_URL is required');
	return (pool ??= new Pool({
		connectionString: env.DATABASE_URL,
		max: 10,
		ssl: env.DATABASE_SSL === 'true' ? { rejectUnauthorized: true } : undefined
	}));
}
export async function authenticate(email: string, tenantSlug: string) {
	const pool = getPool();
	const tenant = await pool.query('SELECT id FROM tenants WHERE slug=$1 AND suspended_at IS NULL', [
		tenantSlug
	]);
	if (!tenant.rowCount) return undefined;
	const client = await pool.connect();
	try {
		await client.query('BEGIN');
		await client.query("SELECT set_config('app.tenant_id',$1,true)", [tenant.rows[0].id]);
		const result = await client.query(
			`SELECT u.id, u.email, u.display_name, u.password_hash, u.session_version, u.email_verified_at, m.role, $2 AS slug FROM users u JOIN memberships m ON m.user_id=u.id WHERE lower(u.email)=lower($1) AND m.tenant_id=$3 AND u.disabled_at IS NULL AND m.status='active'`,
			[email, tenantSlug, tenant.rows[0].id]
		);
		await client.query('COMMIT');
		return result.rows[0] as
			| {
					id: string;
					email: string;
					display_name: string;
					password_hash: string;
					session_version: number;
					email_verified_at: Date | null;
					role: string;
					slug: string;
			  }
			| undefined;
	} catch (error) {
		await client.query('ROLLBACK');
		throw error;
	} finally {
		client.release();
	}
}

export type SessionClaims = {
	userId: string;
	tenantSlug: string;
	role: string;
	sessionId?: string;
	sessionVersion?: number;
	demo: boolean;
};
export async function registerSession(
	userId: string,
	tenantSlug: string,
	version: number,
	expiresAt: Date
) {
	const pool = getPool();
	const tenant = await pool.query('SELECT id FROM tenants WHERE slug=$1 AND suspended_at IS NULL', [
		tenantSlug
	]);
	if (!tenant.rowCount) throw new Error('Tenant not found.');
	const id = randomUUID();
	const client = await pool.connect();
	try {
		await client.query('BEGIN');
		await client.query("SELECT set_config('app.tenant_id',$1,true)", [tenant.rows[0].id]);
		await client.query(
			'INSERT INTO auth_sessions(id,tenant_id,user_id,session_version,expires_at) VALUES($1,$2,$3,$4,$5)',
			[id, tenant.rows[0].id, userId, version, expiresAt]
		);
		await client.query('COMMIT');
		return id;
	} catch (error) {
		await client.query('ROLLBACK');
		throw error;
	} finally {
		client.release();
	}
}

export async function validateSession(session: SessionClaims) {
	if (!session.sessionId || !Number.isInteger(session.sessionVersion)) return false;
	const pool = getPool();
	const tenant = await pool.query('SELECT id FROM tenants WHERE slug=$1 AND suspended_at IS NULL', [
		session.tenantSlug
	]);
	if (!tenant.rowCount) return false;
	const client = await pool.connect();
	try {
		await client.query('BEGIN');
		await client.query("SELECT set_config('app.tenant_id',$1,true)", [tenant.rows[0].id]);
		const result = await client.query(
			`SELECT 1 FROM auth_sessions s JOIN users u ON u.id=s.user_id JOIN memberships m ON m.tenant_id=s.tenant_id AND m.user_id=s.user_id WHERE s.id=$1 AND s.user_id=$2 AND s.tenant_id=$3 AND s.session_version=$4 AND u.session_version=$4 AND u.email_verified_at IS NOT NULL AND u.disabled_at IS NULL AND m.status='active' AND m.role=$5 AND s.revoked_at IS NULL AND s.expires_at>now()`,
			[session.sessionId, session.userId, tenant.rows[0].id, session.sessionVersion, session.role]
		);
		await client.query('COMMIT');
		return Boolean(result.rowCount);
	} catch (error) {
		await client.query('ROLLBACK');
		throw error;
	} finally {
		client.release();
	}
}

export async function revokeSession(session: SessionClaims) {
	if (!session.sessionId) return;
	const pool = getPool();
	const tenant = await pool.query('SELECT id FROM tenants WHERE slug=$1 AND suspended_at IS NULL', [
		session.tenantSlug
	]);
	if (!tenant.rowCount) return;
	const client = await pool.connect();
	try {
		await client.query('BEGIN');
		await client.query("SELECT set_config('app.tenant_id',$1,true)", [tenant.rows[0].id]);
		await client.query(
			'UPDATE auth_sessions SET revoked_at=now() WHERE id=$1 AND user_id=$2 AND tenant_id=$3 AND revoked_at IS NULL',
			[session.sessionId, session.userId, tenant.rows[0].id]
		);
		await client.query('COMMIT');
	} catch (error) {
		await client.query('ROLLBACK');
		throw error;
	} finally {
		client.release();
	}
}

export async function createOwnerAccount(input: {
	email: string;
	name: string;
	passwordHash: string;
	organizationName: string;
	slug: string;
	tenantId?: string;
	verification?: { id: string; tokenHash: string; tokenEnvelope: string; expiresAt: Date };
	sessionExpiresAt?: Date;
	testOnlyVerifiedFixture?: boolean;
}) {
	const client = await getPool().connect();
	const userId = randomUUID();
	const tenantId = input.tenantId ?? randomUUID();
	const sessionId = randomUUID();
	if (!input.verification && !input.testOnlyVerifiedFixture)
		throw new Error('Owner account creation requires a prepared email verification token.');
	try {
		await client.query('BEGIN');
		await client.query('INSERT INTO tenants(id,slug,legal_name) VALUES($1,$2,$3)', [
			tenantId,
			input.slug,
			input.organizationName
		]);
		await client.query("SELECT set_config('app.tenant_id',$1,true)", [tenantId]);
		await client.query("SELECT set_config('app.signup_user_id',$1,true)", [userId]);
		await client.query(
			'INSERT INTO users(id,email,display_name,password_hash,email_verified_at) VALUES($1,$2,$3,$4,$5)',
			[userId, input.email, input.name, input.passwordHash, input.verification ? null : new Date()]
		);
		await client.query("SELECT set_config('app.signup_user_id','',true)");
		await client.query(
			"INSERT INTO memberships(tenant_id,user_id,role,status) VALUES($1,$2,'owner','active')",
			[tenantId, userId]
		);
		if (input.verification)
			await client.query(
				`INSERT INTO identity_tokens(id,tenant_id,user_id,purpose,email,token_hash,token_envelope,metadata,expires_at)
			 VALUES($1,$2,$3,'verify_email',$4,$5,$6,$7,$8)`,
				[
					input.verification.id,
					tenantId,
					userId,
					input.email,
					input.verification.tokenHash,
					input.verification.tokenEnvelope,
					{ name: input.name },
					input.verification.expiresAt
				]
			);
		if (input.verification)
			await client.query(
				"INSERT INTO outbox_events(tenant_id,event_type,payload,idempotency_key) VALUES($1,'identity.email',$2,$3)",
				[tenantId, { tokenId: input.verification.id }, `identity:${input.verification.id}`]
			);
		if (!input.verification && input.sessionExpiresAt)
			await client.query(
				'INSERT INTO auth_sessions(id,tenant_id,user_id,session_version,expires_at) VALUES($1,$2,$3,1,$4)',
				[sessionId, tenantId, userId, input.sessionExpiresAt]
			);
		await client.query(
			'INSERT INTO audit_log(tenant_id,actor_id,action,resource,details) VALUES($1,$2,$3,$4,$5)',
			[tenantId, userId, 'account.created', 'tenant', { slug: input.slug }]
		);
		await client.query('COMMIT');
		return {
			userId,
			tenantId,
			sessionId,
			email: input.email,
			name: input.name,
			role: 'owner' as const,
			sessionVersion: 1,
			tenant: {
				id: tenantId,
				slug: input.slug,
				name: input.organizationName,
				currency: 'USD',
				timeZone: 'UTC',
				demo: false
			}
		};
	} catch (error) {
		await client.query('ROLLBACK');
		throw error;
	} finally {
		client.release();
	}
}

export async function listMemberships(userId: string) {
	const pool = getPool();
	const tenants = await pool.query(
		'SELECT id,slug,legal_name,currency,timezone FROM tenants ORDER BY legal_name'
	);
	const client = await pool.connect();
	try {
		await client.query('BEGIN');
		const memberships: Array<{
			id: string;
			slug: string;
			name: string;
			currency: string;
			timeZone: string;
			role: string;
		}> = [];
		for (const t of tenants.rows) {
			await client.query("SELECT set_config('app.tenant_id',$1,true)", [t.id]);
			const found = await client.query(
				"SELECT role FROM memberships WHERE tenant_id=$1 AND user_id=$2 AND status='active'",
				[t.id, userId]
			);
			if (found.rowCount)
				memberships.push({
					id: t.id,
					slug: t.slug,
					name: t.legal_name,
					currency: t.currency,
					timeZone: t.timezone,
					role: found.rows[0].role
				});
		}
		await client.query('COMMIT');
		return memberships;
	} catch (error) {
		await client.query('ROLLBACK');
		throw error;
	} finally {
		client.release();
	}
}
export async function workspaceFromPostgres(
	slug: string,
	userId: string,
	role: string,
	options: { compact?: boolean; contactLimit?: number } = {}
): Promise<Workspace | null> {
	const compact = options.compact === true;
	const contactLimit = Math.min(500, Math.max(1, options.contactLimit || 200));
	const p = getPool();
	const tenant = await p.query(
		'SELECT id, slug, legal_name, currency, timezone, locale FROM tenants WHERE slug=$1 AND suspended_at IS NULL',
		[slug]
	);
	if (!tenant.rowCount) return null;
	const t = tenant.rows[0];
	const client = await p.connect();
	try {
		await client.query('BEGIN');
		await client.query("SELECT set_config('app.tenant_id',$1,true)", [t.id]);
		const membership = await client.query(
			"SELECT m.role,u.email,u.display_name FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.tenant_id=$1 AND m.user_id=$2 AND m.status='active' AND u.disabled_at IS NULL",
			[t.id, userId]
		);
		if (!membership.rowCount) {
			await client.query('ROLLBACK');
			return null;
		}
		const activeRole = membership.rows[0].role as string;
		const [
			contacts,
			gifts,
			campaigns,
			tasks,
			prospects,
			activityRows,
			extraRows,
			graphRows,
			settingsRows,
			aliasRows,
			overviewRows
		] = await Promise.all([
			compact
				? client.query(
						'SELECT id,name,email,stage,tags,data,created_at AS "createdAt" FROM contacts WHERE tenant_id=$1 AND archived_at IS NULL AND merged_into IS NULL ORDER BY name,id LIMIT $2',
						[t.id, contactLimit]
					)
				: client.query(
						'SELECT id,name,email,stage,tags,data,created_at AS "createdAt" FROM contacts WHERE tenant_id=$1 AND archived_at IS NULL',
						[t.id]
					),
			compact
				? Promise.resolve({ rows: [] } as any)
				: client.query(
						'SELECT id,contact_id AS "contactId",campaign_id AS "campaignId",fund_id AS "fundId",correction_of AS "correctionOf",amount_minor AS "amountMinor",currency,kind,status,occurred_at AS "occurredAt",data FROM gifts WHERE tenant_id=$1 ORDER BY occurred_at DESC',
						[t.id]
					),
			client.query(
				'SELECT id,name,goal_minor AS "goalMinor",currency,status,data FROM campaigns WHERE tenant_id=$1',
				[t.id]
			),
			compact
				? client.query(
						`SELECT id,title,contact_id AS "contactId",due_at AS "dueAt",priority,status,data FROM tasks WHERE tenant_id=$1 AND status<>'completed' ORDER BY due_at NULLS LAST LIMIT 100`,
						[t.id]
					)
				: client.query(
						'SELECT id,title,contact_id AS "contactId",due_at AS "dueAt",priority,status,data FROM tasks WHERE tenant_id=$1',
						[t.id]
					),
			compact
				? client.query(
						'SELECT id,name,stage,score,match_status AS "matchStatus",data FROM prospects WHERE tenant_id=$1 ORDER BY updated_at DESC LIMIT 200',
						[t.id]
					)
				: client.query(
						'SELECT id,name,stage,score,match_status AS "matchStatus",data FROM prospects WHERE tenant_id=$1',
						[t.id]
					),
			compact
				? Promise.resolve({ rows: [] } as any)
				: client.query(
						'SELECT id,contact_id AS "contactId",kind,summary,occurred_at AS "occurredAt",data FROM activities WHERE tenant_id=$1',
						[t.id]
					),
			compact
				? client.query(
						'SELECT resource,id,data,created_at AS "createdAt",updated_at AS "updatedAt" FROM (SELECT resource,id,data,created_at,updated_at,row_number() OVER(PARTITION BY resource ORDER BY updated_at DESC,id) AS rn FROM workspace_records WHERE tenant_id=$1 AND archived_at IS NULL) x WHERE rn<=100',
						[t.id]
					)
				: client.query(
						'SELECT resource,id,data,created_at AS "createdAt",updated_at AS "updatedAt" FROM workspace_records WHERE tenant_id=$1 AND archived_at IS NULL',
						[t.id]
					),
			compact
				? Promise.resolve({ rows: [] } as any)
				: client.query(
						'SELECT e.id,e.from_id AS "fromId",e.to_id AS "toId",e.edge_type AS kind,e.evidence_type AS "evidenceType",e.provenance_label AS evidence,e.provenance_url AS "sourceUrl",e.observed_at AS "observedAt",e.confidence,e.privacy_scope AS "privacyScope",e.verification_status AS "verificationStatus",e.last_verified_at AS "lastVerifiedAt",e.archived_at AS "archivedAt",e.supersedes_id AS "supersedesId",e.source_id AS "sourceId",f.node_type AS "fromNodeType",f.display_name AS "fromName",t.node_type AS "toNodeType",t.display_name AS "toName",rs.name AS "sourceName",rs.license_label AS "sourceLicense",rs.permitted_uses AS "permittedUses",rs.export_allowed AS "exportAllowed",rs.outreach_allowed AS "outreachAllowed",rs.enabled AS "sourceEnabled" FROM graph_edges e LEFT JOIN graph_nodes f ON f.tenant_id=e.tenant_id AND f.entity_id=e.from_id LEFT JOIN graph_nodes t ON t.tenant_id=e.tenant_id AND t.entity_id=e.to_id LEFT JOIN research_sources rs ON rs.tenant_id=e.tenant_id AND rs.id=e.source_id WHERE e.tenant_id=$1 ORDER BY e.created_at DESC',
						[t.id]
					),
			client.query('SELECT data FROM user_settings WHERE tenant_id=$1 AND user_id=$2', [
				t.id,
				userId
			]),
			compact
				? Promise.resolve({ rows: [] } as any)
				: client.query(
						'SELECT id,name,merged_into AS "mergedInto" FROM contacts WHERE tenant_id=$1 AND merged_into IS NOT NULL',
						[t.id]
					),
			compact
				? client.query(
						`WITH metrics AS (SELECT COALESCE(sum(CASE WHEN kind NOT IN ('correction','pledge') AND status='recorded' THEN amount_minor ELSE 0 END),0) gross,COALESCE(sum(CASE WHEN kind='correction' AND status='refunded' THEN amount_minor ELSE 0 END),0) refunds,COALESCE(sum(CASE WHEN kind='correction' AND status='disputed' THEN amount_minor ELSE 0 END),0) disputes,COALESCE(sum(CASE WHEN kind='correction' AND data->>'direction'='reinstatement' AND status='recorded' THEN amount_minor ELSE 0 END),0) reinstatements,COALESCE(sum(CASE WHEN kind='pledge' OR status='pledged' THEN amount_minor ELSE 0 END),0) pledges,COALESCE(sum(amount_minor) FILTER(WHERE status='recorded' AND kind='recurring'),0) recurring,count(*) FILTER(WHERE status='recorded' AND kind='recurring')::int recurring_count FROM gifts WHERE tenant_id=$1 AND currency=$2),months AS(SELECT to_char(date_trunc('month',occurred_at),'YYYY-MM') AS month_key,sum(amount_minor) AS amount FROM gifts WHERE tenant_id=$1 AND currency=$2 AND status='recorded' AND kind NOT IN('correction','pledge') GROUP BY 1 ORDER BY 1 DESC LIMIT 18),recent AS(SELECT g.id,g.contact_id AS "contactId",g.campaign_id AS "campaignId",g.amount_minor AS "amountMinor",g.currency,g.kind,g.status,g.occurred_at AS "occurredAt",c.name AS "contactName" FROM gifts g LEFT JOIN contacts c ON c.tenant_id=g.tenant_id AND c.id=g.contact_id WHERE g.tenant_id=$1 AND g.currency=$2 ORDER BY g.occurred_at DESC,g.id DESC LIMIT 4),campaign AS(SELECT campaign_id AS id,COALESCE(sum(amount_minor) FILTER(WHERE status='recorded' AND kind NOT IN('correction','pledge')),0) AS amount FROM gifts WHERE tenant_id=$1 AND currency=$2 GROUP BY campaign_id) SELECT (SELECT count(*)::int FROM contacts WHERE tenant_id=$1 AND archived_at IS NULL AND merged_into IS NULL) AS "contactCount",(SELECT count(*)::int FROM gifts WHERE tenant_id=$1) AS "giftEventCount",metrics.gross AS "grossMinor",metrics.refunds AS "refundMinor",metrics.disputes AS "disputeMinor",metrics.reinstatements AS "reinstatementMinor",metrics.pledges AS "pledgedMinor",metrics.recurring AS "recurringMinor",metrics.recurring_count AS "recurringCount",COALESCE((SELECT jsonb_agg(months ORDER BY month_key) FROM months),'[]'::jsonb) AS "byMonth",COALESCE((SELECT jsonb_agg(recent ORDER BY "occurredAt" DESC) FROM recent),'[]'::jsonb) AS "recentGifts",COALESCE((SELECT jsonb_object_agg(COALESCE(id::text,'unassigned'),amount) FROM campaign),'{}'::jsonb) AS "campaignGiving" FROM metrics`,
						[t.id, t.currency]
					)
				: Promise.resolve({ rows: [] } as any)
		]);
		await client.query(
			'INSERT INTO audit_log(tenant_id,actor_id,action,resource,details) VALUES($1,$2,$3,$4,$5)',
			[t.id, userId, 'workspace.read', 'workspace', { role: activeRole }]
		);
		await client.query('COMMIT');
		const rows = Object.fromEntries(
			collectionNames
				.filter((r) => r !== 'settings')
				.map((resource) => [resource, [] as Record<string, unknown>[]])
		) as Record<Exclude<Resource, 'settings'>, Record<string, unknown>[]>;
		const enrich = (list: Record<string, unknown>[]) =>
			list.map(({ data, ...columns }) => ({ ...((data as object) || {}), ...columns }));
		rows.contacts = enrich(contacts.rows);
		rows.gifts = enrich(gifts.rows).map((gift) => ({
			...gift,
			amountMinor: safeMinorUnits(gift.amountMinor, 'Gift amount')
		}));
		rows.campaigns = enrich(campaigns.rows).map((campaign) => ({
			...campaign,
			goalMinor: safeMinorUnits(campaign.goalMinor, 'Campaign goal')
		}));
		rows.tasks = enrich(tasks.rows);
		rows.prospects = enrich(prospects.rows).map((prospect) => ({
			...prospect,
			...(prospect.score == null ? {} : { score: Number(prospect.score) })
		}));
		rows.activities = enrich(activityRows.rows);
		for (const row of extraRows.rows)
			if (row.resource in rows)
				rows[row.resource as Exclude<Resource, 'settings'>].push({
					...(row.data as object),
					id: row.id,
					createdAt: row.createdAt,
					updatedAt: row.updatedAt
				});
		// Edge privacy is enforced before the generic workspace redactor: an
		// authenticated membership alone must not expose restricted evidence.
		rows.relationships.push(
			...graphRows.rows.filter((edge: any) =>
				canViewGraphEvidence(activeRole, String(edge.privacyScope))
			)
		);
		const mayViewWealth = ['owner', 'admin', 'fundraising_manager', 'fundraiser'].includes(
			activeRole
		);
		const mayViewSensitiveNotes = ['owner', 'admin'].includes(activeRole);
		const mayViewDirectContact = [
			'owner',
			'admin',
			'finance_manager',
			'finance',
			'fundraising_manager',
			'fundraiser',
			'marketer',
			'analyst'
		].includes(activeRole);
		for (const resource of Object.keys(rows) as Array<Exclude<Resource, 'settings'>>) {
			rows[resource] = rows[resource].map((record) =>
				redactWorkspaceValue(record, {
					directContact: mayViewDirectContact,
					wealth: mayViewWealth,
					sensitiveNotes: mayViewSensitiveNotes,
					gift: resource === 'gifts'
				})
			);
		}
		const visibleSettings = redactWorkspaceValue(
			settingsRows.rows[0]?.data || {
				organizationName: t.legal_name,
				currency: t.currency,
				timeZone: t.timezone,
				locale: t.locale,
				demo: false
			},
			{
				directContact: mayViewDirectContact,
				wealth: mayViewWealth,
				sensitiveNotes: mayViewSensitiveNotes
			}
		);
		const memberships = await listMemberships(userId);
		return {
			tenant: {
				id: t.id,
				slug: t.slug,
				name: t.legal_name,
				currency: t.currency,
				timeZone: t.timezone,
				demo: false
			},
			user: {
				id: userId,
				email: membership.rows[0].email,
				name: membership.rows[0].display_name,
				role: activeRole
			},
			memberships,
			...rows,
			contactAliases: aliasRows.rows,
			...(compact
				? {
						overview: compactOverview(overviewRows.rows[0] || {}, contactLimit, {
							directContact: mayViewDirectContact,
							wealth: mayViewWealth,
							sensitiveNotes: mayViewSensitiveNotes
						})
					}
				: {}),
			settings: visibleSettings
		} as Workspace;
	} catch (error) {
		await client.query('ROLLBACK');
		throw error;
	} finally {
		client.release();
	}
}

function compactOverview(
	row: Record<string, any>,
	contactLimit: number,
	privacy: { directContact: boolean; wealth: boolean; sensitiveNotes: boolean }
) {
	const byMonth = Array.isArray(row.byMonth)
		? row.byMonth.map((item: any) => ({
				month: String(item.month_key),
				amountMinor: safeMinorUnits(item.amount, 'Monthly giving')
			}))
		: [];
	const recentGifts = Array.isArray(row.recentGifts)
		? row.recentGifts.map((gift: any) =>
				redactWorkspaceValue(
					{ ...gift, amountMinor: safeMinorUnits(gift.amountMinor, 'Recent gift amount') },
					{ ...privacy, gift: true }
				)
			)
		: [];
	const campaignGiving = Object.fromEntries(
		Object.entries(row.campaignGiving || {}).map(([id, amount]) => [
			id,
			safeMinorUnits(amount, 'Campaign giving')
		])
	);
	const grossMinor = safeMinorUnits(row.grossMinor || 0, 'Gross giving');
	const refundMinor = safeMinorUnits(row.refundMinor || 0, 'Refunds');
	const disputeMinor = safeMinorUnits(row.disputeMinor || 0, 'Disputes');
	const reinstatementMinor = safeMinorUnits(row.reinstatementMinor || 0, 'Reinstatements');
	return {
		bounded: true,
		contactLimit,
		contactCount: Number(row.contactCount || 0),
		giftEventCount: Number(row.giftEventCount || 0),
		grossMinor,
		refundMinor,
		disputeMinor,
		reinstatementMinor,
		netRecordedMinor: grossMinor - refundMinor - disputeMinor + reinstatementMinor,
		pledgedMinor: safeMinorUnits(row.pledgedMinor || 0, 'Pledged giving'),
		recurringMinor: safeMinorUnits(row.recurringMinor || 0, 'Recurring giving'),
		recurringCount: Number(row.recurringCount || 0),
		byMonth,
		recentGifts,
		campaignGiving
	};
}

export async function mutatePostgres(
	slug: string,
	userId: string,
	resource: Resource,
	data: Record<string, unknown>,
	action: 'create' | 'update' | 'archive' | 'simulate',
	precondition?: { expectedVersion: string }
) {
	const p = getPool();
	const tenantResult = await p.query(
		'SELECT id FROM tenants WHERE slug=$1 AND suspended_at IS NULL',
		[slug]
	);
	if (!tenantResult.rowCount) throw new Error('Tenant not found');
	const tenantId = tenantResult.rows[0].id as string;
	const client = await p.connect();
	try {
		await client.query('BEGIN');
		await client.query("SELECT set_config('app.tenant_id',$1,true)", [tenantId]);
		const membership = await client.query(
			"SELECT m.role FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.tenant_id=$1 AND m.user_id=$2 AND m.status='active' AND u.disabled_at IS NULL",
			[tenantId, userId]
		);
		if (!membership.rowCount)
			throw Object.assign(new Error('Your tenant membership is no longer active.'), {
				status: 403
			});
		const activeRole = membership.rows[0].role as string;
		assertRoleCanMutate(activeRole, resource, action);
		if (precondition) {
			const id = String(data.id ?? '');
			const table = ['contacts', 'campaigns', 'tasks', 'prospects'].includes(resource)
				? resource
				: 'workspace_records';
			const current =
				table === 'workspace_records'
					? await client.query(
							'SELECT xmin::text AS version FROM workspace_records WHERE tenant_id=$1 AND resource=$2 AND id=$3 FOR UPDATE',
							[tenantId, resource, id]
						)
					: await client.query(
							`SELECT xmin::text AS version FROM ${table} WHERE tenant_id=$1 AND id=$2 FOR UPDATE`,
							[tenantId, id]
						);
			if (!current.rowCount)
				throw Object.assign(new Error('The selected record is no longer available.'), {
					status: 409
				});
			if (current.rows[0].version !== precondition.expectedVersion)
				throw Object.assign(
					new Error(
						'The record changed after the preview. Ask the assistant for a fresh proposal.'
					),
					{ status: 409 }
				);
		}
		if (action === 'simulate') {
			if (resource !== 'automations')
				throw new Error('Simulation is only available for automations.');
			if (data.id) {
				const automation = await client.query(
					"SELECT 1 FROM workspace_records WHERE tenant_id=$1 AND resource='automations' AND id=$2",
					[tenantId, data.id]
				);
				if (!automation.rowCount)
					throw Object.assign(new Error('Automation not found in the active tenant.'), {
						status: 404
					});
			}
			const simulation = {
				...data,
				simulated: true,
				wouldSend: false,
				result: 'Simulation only; no messages or paid services were invoked.'
			};
			await client.query(
				'INSERT INTO audit_log(tenant_id,actor_id,action,resource,record_id,details) VALUES($1,$2,$3,$4,$5,$6)',
				[
					tenantId,
					userId,
					'automation.simulated',
					resource,
					data.id || null,
					{ outcome: 'no side effects' }
				]
			);
			await client.query('COMMIT');
			return simulation;
		}
		if (resource === 'gifts' && action !== 'create')
			throw new Error('Gift events are immutable; record a correction as a new gift event.');
		if (resource === 'contacts' && (action === 'update' || action === 'archive')) {
			const active = await client.query(
				'SELECT 1 FROM contacts WHERE tenant_id=$1 AND id=$2 AND archived_at IS NULL AND merged_into IS NULL FOR UPDATE',
				[tenantId, data.id]
			);
			if (!active.rowCount)
				throw Object.assign(
					new Error('Contact is archived, merged, or missing in the active tenant.'),
					{ status: 404 }
				);
		}
		const references: Array<{ field: string; table: string; id: unknown }> = [];
		if (
			['gifts', 'tasks', 'activities', 'introductions', 'emails'].includes(resource) &&
			data.contactId
		)
			references.push({ field: 'contactId', table: 'contacts', id: data.contactId });
		if (resource === 'gifts' && data.campaignId)
			references.push({ field: 'campaignId', table: 'campaigns', id: data.campaignId });
		if (resource === 'gifts' && data.correctionOf)
			references.push({ field: 'correctionOf', table: 'gifts', id: data.correctionOf });
		if (resource === 'introductions' && data.prospectId)
			references.push({ field: 'prospectId', table: 'prospects', id: data.prospectId });
		for (const reference of references) {
			const activeContactCheck =
				reference.table === 'contacts' ? ' AND archived_at IS NULL AND merged_into IS NULL' : '';
			const exists = await client.query(
				`SELECT EXISTS(SELECT 1 FROM ${reference.table} WHERE tenant_id=$1 AND id=$2${activeContactCheck}) AS found`,
				[tenantId, reference.id]
			);
			if (!exists.rows[0].found)
				throw Object.assign(
					new Error(`${reference.field} must reference a record in the active tenant.`),
					{ status: 422 }
				);
		}
		if (resource === 'emails' && data.segmentId) {
			const exists = await client.query(
				"SELECT EXISTS(SELECT 1 FROM workspace_records WHERE tenant_id=$1 AND resource='segments' AND id=$2 AND archived_at IS NULL) AS found",
				[tenantId, data.segmentId]
			);
			if (!exists.rows[0].found)
				throw Object.assign(new Error('segmentId must reference a segment in the active tenant.'), {
					status: 422
				});
		}
		if (resource === 'emails' && data.templateId) {
			const exists = await client.query(
				'SELECT EXISTS(SELECT 1 FROM email_templates WHERE tenant_id=$1 AND id=$2) AS found',
				[tenantId, data.templateId]
			);
			if (!exists.rows[0].found)
				throw Object.assign(
					new Error('templateId must reference a template in the active tenant.'),
					{ status: 422 }
				);
		}
		if (resource === 'relationships') {
			for (const field of ['fromId', 'toId']) {
				const exists = await client.query(
					'SELECT EXISTS(SELECT 1 FROM contacts WHERE tenant_id=$1 AND id=$2 AND archived_at IS NULL AND merged_into IS NULL UNION ALL SELECT 1 FROM prospects WHERE tenant_id=$1 AND id=$2 UNION ALL SELECT 1 FROM workspace_records WHERE tenant_id=$1 AND id=$2) AS found',
					[tenantId, data[field]]
				);
				if (!exists.rows[0].found)
					throw Object.assign(new Error(`${field} must reference a record in the active tenant.`), {
						status: 422
					});
			}
		}
		if (resource === 'households') {
			for (const memberId of (data.memberIds as unknown[]) || []) {
				const exists = await client.query(
					'SELECT EXISTS(SELECT 1 FROM contacts WHERE tenant_id=$1 AND id=$2 AND archived_at IS NULL) AS found',
					[tenantId, memberId]
				);
				if (!exists.rows[0].found)
					throw Object.assign(
						new Error('Every household member must reference an active contact in this tenant.'),
						{ status: 422 }
					);
			}
		}
		let item: Record<string, unknown>;
		if (resource === 'settings') {
			const safeSettings = {
				...data,
				emailSendingEnabled: false,
				paymentsEnabled: false,
				paidResearchEnabled: false
			};
			await client.query(
				'INSERT INTO user_settings(tenant_id,user_id,data) VALUES($1,$2,$3) ON CONFLICT(tenant_id,user_id) DO UPDATE SET data=user_settings.data || EXCLUDED.data,updated_at=now()',
				[tenantId, userId, safeSettings]
			);
			item = safeSettings;
		} else if (
			['contacts', 'campaigns', 'gifts', 'prospects', 'tasks', 'activities'].includes(resource)
		) {
			const id = String(data.id || crypto.randomUUID());
			if (action === 'update' || action === 'archive') {
				if (resource === 'gifts' || resource === 'activities')
					throw new Error(`${resource} records are immutable; add a new event instead.`);
				let updated;
				if (resource === 'contacts')
					updated = await client.query(
						"UPDATE contacts SET name=$3,email=nullif(lower($4),''),stage=$5,tags=$6,data=data || $7,updated_at=now(),archived_at=CASE WHEN $8 THEN now() ELSE archived_at END WHERE tenant_id=$1 AND id=$2 RETURNING id",
						[
							tenantId,
							id,
							data.name,
							data.email || '',
							data.stage || 'new',
							data.tags || [],
							data,
							action === 'archive'
						]
					);
				else if (resource === 'campaigns')
					updated = await client.query(
						'UPDATE campaigns SET name=$3,goal_minor=$4,currency=$5,status=$6,data=data || $7,updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING id',
						[
							tenantId,
							id,
							data.name,
							data.goalMinor || 0,
							data.currency || 'USD',
							action === 'archive' ? 'archived' : data.status || 'draft',
							data
						]
					);
				else if (resource === 'prospects')
					updated = await client.query(
						'UPDATE prospects SET name=$3,stage=$4,score=$5,match_status=$6,data=data || $7,updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING id',
						[
							tenantId,
							id,
							data.name,
							action === 'archive' ? 'archived' : data.stage || 'discovered',
							data.score ?? null,
							data.matchStatus || 'possible',
							data
						]
					);
				else
					updated = await client.query(
						'UPDATE tasks SET title=$3,contact_id=$4,due_at=$5,priority=$6,status=$7,data=data || $8,updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING id',
						[
							tenantId,
							id,
							data.title,
							data.contactId || null,
							data.dueAt || null,
							data.priority || 'normal',
							action === 'archive' ? 'cancelled' : data.status || 'open',
							data
						]
					);
				if (!updated.rowCount)
					throw Object.assign(new Error('Record not found in the active tenant.'), { status: 404 });
			} else if (resource === 'contacts')
				await client.query(
					"INSERT INTO contacts(tenant_id,id,name,email,stage,tags,data) VALUES($1,$2,$3,nullif(lower($4),''),$5,$6,$7)",
					[tenantId, id, data.name, data.email || '', data.stage || 'new', data.tags || [], data]
				);
			else if (resource === 'campaigns')
				await client.query(
					'INSERT INTO campaigns(tenant_id,id,name,goal_minor,currency,status,data) VALUES($1,$2,$3,$4,$5,$6,$7)',
					[
						tenantId,
						id,
						data.name,
						data.goalMinor || 0,
						data.currency || 'USD',
						data.status || 'draft',
						data
					]
				);
			else if (resource === 'gifts')
				await client.query(
					'INSERT INTO gifts(tenant_id,id,contact_id,campaign_id,amount_minor,currency,kind,status,occurred_at,correction_of,data) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
					[
						tenantId,
						id,
						data.contactId || null,
						data.campaignId || null,
						data.amountMinor,
						data.currency,
						data.kind,
						data.status,
						data.occurredAt || new Date(),
						data.correctionOf || null,
						data
					]
				);
			else if (resource === 'prospects')
				await client.query(
					'INSERT INTO prospects(tenant_id,id,name,stage,score,match_status,data) VALUES($1,$2,$3,$4,$5,$6,$7)',
					[
						tenantId,
						id,
						data.name,
						data.stage || 'discovered',
						data.score ?? null,
						data.matchStatus || 'possible',
						data
					]
				);
			else if (resource === 'tasks')
				await client.query(
					'INSERT INTO tasks(tenant_id,id,title,contact_id,due_at,priority,status,data) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
					[
						tenantId,
						id,
						data.title,
						data.contactId || null,
						data.dueAt || null,
						data.priority || 'normal',
						data.status || 'open',
						data
					]
				);
			else
				await client.query(
					'INSERT INTO activities(tenant_id,id,contact_id,kind,summary,data) VALUES($1,$2,$3,$4,$5,$6)',
					[tenantId, id, data.contactId || null, data.kind, data.summary, data]
				);
			item = {
				...data,
				id,
				...(action === 'create'
					? { createdAt: new Date().toISOString() }
					: {
							updatedAt: new Date().toISOString(),
							...(action === 'archive' ? { archived: true } : {})
						})
			};
		} else {
			const id = String(data.id || crypto.randomUUID());
			if (action === 'update' || action === 'archive') {
				const updated = await client.query(
					'UPDATE workspace_records SET data=data || $4,updated_at=now(),archived_at=CASE WHEN $5 THEN now() ELSE archived_at END WHERE tenant_id=$1 AND resource=$2 AND id=$3 RETURNING id',
					[tenantId, resource, id, data, action === 'archive']
				);
				if (!updated.rowCount)
					throw Object.assign(new Error('Record not found in the active tenant.'), { status: 404 });
			} else
				await client.query(
					'INSERT INTO workspace_records(tenant_id,resource,id,data) VALUES($1,$2,$3,$4)',
					[tenantId, resource, id, data]
				);
			item = { ...data, id, updatedAt: new Date().toISOString() };
		}

		if (resource === 'contacts' && action !== 'archive') {
			for (const kind of ['email', 'phone'] as const) {
				const value = String(data[kind] || '').trim();
				if (!value) continue;
				const normalized = kind === 'email' ? value.toLowerCase() : value.replace(/[^0-9+]/g, '');
				if (kind === 'phone' && !/^\+?[0-9]{7,15}$/.test(normalized))
					throw Object.assign(new Error('Enter a valid phone number with country code.'), {
						status: 422
					});
				await client.query(
					'UPDATE contact_methods SET preferred=false WHERE tenant_id=$1 AND contact_id=$2 AND kind=$3',
					[tenantId, item.id, kind]
				);
				const existing = await client.query(
					'SELECT id FROM contact_methods WHERE tenant_id=$1 AND contact_id=$2 AND kind=$3 AND normalized_value=$4 LIMIT 1',
					[tenantId, item.id, kind, normalized]
				);
				if (existing.rowCount)
					await client.query(
						'UPDATE contact_methods SET value=$3,preferred=true WHERE tenant_id=$1 AND id=$2',
						[tenantId, existing.rows[0].id, value]
					);
				else
					await client.query(
						'INSERT INTO contact_methods(tenant_id,contact_id,kind,value,normalized_value,preferred) VALUES($1,$2,$3,$4,$5,true)',
						[tenantId, item.id, kind, value, normalized]
					);
			}
			if (typeof data.consent === 'boolean') {
				const status = data.consent ? 'granted' : 'withdrawn';
				const previous = await client.query(
					"SELECT status FROM consents WHERE tenant_id=$1 AND contact_id=$2 AND channel='email' AND purpose='marketing' ORDER BY recorded_at DESC LIMIT 1",
					[tenantId, item.id]
				);
				if (previous.rows[0]?.status !== status)
					await client.query(
						"INSERT INTO consents(tenant_id,contact_id,channel,purpose,status,source,lawful_basis,actor_id) VALUES($1,$2,'email','marketing',$3,'Staff contact form: recorded by authenticated actor','consent',$4)",
						[tenantId, item.id, status, userId]
					);
				if (!data.consent && data.email)
					await client.query(
						"INSERT INTO email_suppressions(tenant_id,email,reason,source,created_by) VALUES($1,lower($2),'manual','staff-consent-withdrawal',$3) ON CONFLICT DO NOTHING",
						[tenantId, data.email, userId]
					);
			}
		}
		const eventType = `${resource}.${action === 'update' ? 'updated' : action === 'archive' ? 'archived' : 'created'}`;
		await client.query(
			'INSERT INTO audit_log(tenant_id,actor_id,action,resource,record_id,details) VALUES($1,$2,$3,$4,$5,$6)',
			[tenantId, userId, eventType, resource, item.id || null, { role: activeRole }]
		);
		await client.query(
			'INSERT INTO outbox_events(tenant_id,event_type,payload,idempotency_key) VALUES($1,$2,$3,$4) ON CONFLICT(idempotency_key) DO NOTHING',
			[tenantId, eventType, { resource, recordId: item.id }, `${eventType}:${tenantId}:${item.id}`]
		);
		await client.query('COMMIT');
		return item;
	} catch (error) {
		await client.query('ROLLBACK');
		throw error;
	} finally {
		client.release();
	}
}

const exportRoles = new Set(['owner', 'admin', 'fundraising_manager', 'fundraiser']);
export function canExportContacts(role: string) {
	return exportRoles.has(role);
}

export async function auditPostgresRead(
	slug: string,
	userId: string,
	action: string,
	resource: string
) {
	const p = getPool();
	const tenant = await p.query('SELECT id FROM tenants WHERE slug=$1 AND suspended_at IS NULL', [
		slug
	]);
	if (!tenant.rowCount) throw Object.assign(new Error('Tenant not found.'), { status: 404 });
	const client = await p.connect();
	try {
		await client.query('BEGIN');
		await client.query("SELECT set_config('app.tenant_id',$1,true)", [tenant.rows[0].id]);
		const membership = await client.query(
			"SELECT m.role FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.tenant_id=$1 AND m.user_id=$2 AND m.status='active' AND u.disabled_at IS NULL",
			[tenant.rows[0].id, userId]
		);
		if (!membership.rowCount)
			throw Object.assign(new Error('Your tenant membership is no longer active.'), {
				status: 403
			});
		if (
			['contacts.export', 'contacts.import.preview'].includes(action) &&
			!exportRoles.has(membership.rows[0].role as string)
		)
			throw Object.assign(new Error('Your role cannot import or export contacts.'), {
				status: 403
			});
		await client.query(
			'INSERT INTO audit_log(tenant_id,actor_id,action,resource,details) VALUES($1,$2,$3,$4,$5)',
			[tenant.rows[0].id, userId, action, resource, { role: membership.rows[0].role }]
		);
		await client.query('COMMIT');
		return membership.rows[0].role as string;
	} catch (error) {
		await client.query('ROLLBACK');
		throw error;
	} finally {
		client.release();
	}
}

export async function readAuditPostgres(slug: string, userId: string) {
	const pool = getPool();
	const tenant = await pool.query('SELECT id FROM tenants WHERE slug=$1 AND suspended_at IS NULL', [
		slug
	]);
	if (!tenant.rowCount) throw Object.assign(new Error('Tenant not found.'), { status: 404 });
	const client = await pool.connect();
	try {
		await client.query('BEGIN');
		await client.query("SELECT set_config('app.tenant_id',$1,true)", [tenant.rows[0].id]);
		const member = await client.query(
			"SELECT role FROM memberships WHERE tenant_id=$1 AND user_id=$2 AND status='active'",
			[tenant.rows[0].id, userId]
		);
		if (!member.rowCount)
			throw Object.assign(new Error('Your tenant membership is not active.'), { status: 403 });
		if (!['owner', 'admin'].includes(member.rows[0].role as string))
			throw Object.assign(new Error('Audit history requires an owner or admin role.'), {
				status: 403
			});
		const rows = await client.query(
			'SELECT id,actor_id AS "actorId",action,resource,record_id AS "recordId",details,created_at AS "createdAt" FROM audit_log WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 200',
			[tenant.rows[0].id]
		);
		await client.query('COMMIT');
		return rows.rows;
	} catch (error) {
		await client.query('ROLLBACK');
		throw error;
	} finally {
		client.release();
	}
}

async function beginContactMerge(slug: string, userId: string) {
	const pool = getPool();
	const tenant = await pool.query('SELECT id FROM tenants WHERE slug=$1 AND suspended_at IS NULL', [
		slug
	]);
	if (!tenant.rowCount) throw Object.assign(new Error('Tenant not found.'), { status: 404 });
	const client = await pool.connect();
	try {
		await client.query('BEGIN');
		await client.query("SELECT set_config('app.tenant_id',$1,true)", [tenant.rows[0].id]);
		const membership = await client.query(
			"SELECT role FROM memberships WHERE tenant_id=$1 AND user_id=$2 AND status='active'",
			[tenant.rows[0].id, userId]
		);
		if (!membership.rowCount)
			throw Object.assign(new Error('Your tenant membership is not active.'), { status: 403 });
		if (!['owner', 'admin'].includes(membership.rows[0].role))
			throw Object.assign(new Error('Contact merge requires an owner or admin role.'), {
				status: 403
			});
		return { client, tenantId: tenant.rows[0].id as string };
	} catch (error) {
		await client.query('ROLLBACK');
		client.release();
		throw error;
	}
}
async function loadMergeContacts(
	client: import('pg').PoolClient,
	tenantId: string,
	sourceId: string,
	targetId: string,
	lock = false
) {
	if (sourceId === targetId)
		throw Object.assign(new Error('Choose two different contacts.'), { status: 422 });
	const rows = await client.query(
		`SELECT id,name,email,stage,tags,data,created_at,updated_at,archived_at,merged_into FROM contacts WHERE tenant_id=$1 AND id=ANY($2::uuid[]) ${lock ? 'FOR UPDATE' : ''}`,
		[tenantId, [sourceId, targetId]]
	);
	const source = rows.rows.find((row) => row.id === sourceId);
	const target = rows.rows.find((row) => row.id === targetId);
	if (!source || !target)
		throw Object.assign(new Error('Both contacts must exist in the active workspace.'), {
			status: 404
		});
	if (source.archived_at || source.merged_into || target.archived_at || target.merged_into)
		throw Object.assign(new Error('Archived or already-merged contacts cannot be merged.'), {
			status: 409
		});
	return { source, target };
}
function changedFields(source: Record<string, any>, target: Record<string, any>) {
	const fields = ['name', 'email', 'stage'] as const;
	return fields
		.filter(
			(field) =>
				source[field] &&
				target[field] &&
				String(source[field]).toLowerCase() !== String(target[field]).toLowerCase()
		)
		.map((field) => ({ field, source: source[field], target: target[field] }));
}
function replaceContactRef(
	row: Record<string, any>,
	sourceId: string,
	targetId: string
): Record<string, any> {
	const data = { ...(row.data || {}) };
	if (data.contactId === sourceId) data.contactId = targetId;
	if (Array.isArray(data.memberIds) && data.memberIds.includes(sourceId))
		data.memberIds = [
			...new Set(data.memberIds.map((id: string) => (id === sourceId ? targetId : id)))
		];
	if (data.fromId === sourceId) data.fromId = targetId;
	if (data.toId === sourceId) data.toId = targetId;
	return { ...row, data };
}
async function mergeReferenceSnapshot(
	client: import('pg').PoolClient,
	tenantId: string,
	sourceId: string
) {
	const [tasks, activities, methods, records, files] = await Promise.all([
		client.query(
			'SELECT id,contact_id FROM tasks WHERE tenant_id=$1 AND contact_id=$2 FOR UPDATE',
			[tenantId, sourceId]
		),
		client.query(
			'SELECT id,contact_id FROM activities WHERE tenant_id=$1 AND contact_id=$2 FOR UPDATE',
			[tenantId, sourceId]
		),
		client.query(
			'SELECT id,contact_id FROM contact_methods WHERE tenant_id=$1 AND contact_id=$2 FOR UPDATE',
			[tenantId, sourceId]
		),
		client.query(
			"SELECT resource,id,data FROM workspace_records WHERE tenant_id=$1 AND (data->>'contactId'=$2 OR (data->'memberIds') ? $2 OR data->>'fromId'=$2 OR data->>'toId'=$2) FOR UPDATE",
			[tenantId, sourceId]
		),
		client.query(
			'SELECT id,contact_id FROM file_objects WHERE tenant_id=$1 AND contact_id=$2 FOR UPDATE',
			[tenantId, sourceId]
		)
	]);
	return {
		tasks: tasks.rows,
		activities: activities.rows,
		methods: methods.rows,
		records: records.rows,
		files: files.rows
	};
}
function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
	if (value && typeof value === 'object')
		return `{${Object.keys(value as Record<string, unknown>)
			.sort()
			.map(
				(key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`
			)
			.join(',')}}`;
	return JSON.stringify(value);
}
async function assertMergeReferencesUnchanged(
	client: import('pg').PoolClient,
	tenantId: string,
	expected: Record<string, any>
) {
	const columns = [
		['tasks', 'tasks'],
		['activities', 'activities'],
		['methods', 'contact_methods'],
		['files', 'file_objects']
	] as const;
	for (const [key, table] of columns) {
		const expectedRows = expected[key] as Array<Record<string, any>>;
		if (!expectedRows.length) continue;
		const ids = expectedRows.map((row) => row.id);
		const current = await client.query(
			`SELECT id,contact_id FROM ${table} WHERE tenant_id=$1 AND id=ANY($2::uuid[])`,
			[tenantId, ids]
		);
		const byId = new Map(current.rows.map((row) => [row.id, row.contact_id]));
		if (
			byId.size !== expectedRows.length ||
			expectedRows.some((row) => byId.get(row.id) !== row.contact_id)
		)
			throw Object.assign(new Error('A related record changed after this merge; undo is unsafe.'), {
				status: 409
			});
	}
	for (const row of expected.records as Array<Record<string, any>>) {
		const current = await client.query(
			'SELECT data FROM workspace_records WHERE tenant_id=$1 AND resource=$2 AND id=$3',
			[tenantId, row.resource, row.id]
		);
		if (!current.rowCount || canonicalJson(current.rows[0].data) !== canonicalJson(row.data))
			throw Object.assign(new Error('A related record changed after this merge; undo is unsafe.'), {
				status: 409
			});
	}
}
export async function previewPostgresContactMerge(
	slug: string,
	userId: string,
	sourceId: string,
	targetId: string
) {
	const { client, tenantId } = await beginContactMerge(slug, userId);
	try {
		const { source, target } = await loadMergeContacts(client, tenantId, sourceId, targetId);
		const refs = await mergeReferenceSnapshot(client, tenantId, sourceId);
		const counts = {
			tasks: refs.tasks.length,
			activities: refs.activities.length,
			contactMethods: refs.methods.length,
			workspaceRecords: refs.records.length,
			files: refs.files.length,
			gifts: 0
		};
		const giftCount = await client.query(
			'SELECT count(*)::int AS count FROM gifts WHERE tenant_id=$1 AND contact_id=$2',
			[tenantId, sourceId]
		);
		counts.gifts = giftCount.rows[0].count;
		await client.query('COMMIT');
		return {
			source: { id: source.id, name: source.name, email: source.email },
			target: { id: target.id, name: target.name, email: target.email },
			conflicts: changedFields(source, target),
			referenceCounts: counts,
			ledgerPolicy: 'Gift events remain linked to the original contact and are never rewritten.'
		};
	} catch (error) {
		await client.query('ROLLBACK');
		throw error;
	} finally {
		client.release();
	}
}
export async function mergePostgresContacts(
	slug: string,
	userId: string,
	sourceId: string,
	targetId: string
) {
	const { client, tenantId } = await beginContactMerge(slug, userId);
	try {
		const { source, target } = await loadMergeContacts(client, tenantId, sourceId, targetId, true);
		const references = await mergeReferenceSnapshot(client, tenantId, sourceId);
		const sourceBefore = {
			name: source.name,
			email: source.email,
			stage: source.stage,
			tags: source.tags,
			data: source.data,
			archived_at: source.archived_at,
			merged_into: source.merged_into
		};
		const targetBefore = {
			name: target.name,
			email: target.email,
			stage: target.stage,
			tags: target.tags,
			data: target.data,
			archived_at: target.archived_at,
			merged_into: target.merged_into
		};
		for (const row of references.tasks)
			await client.query(
				'UPDATE tasks SET contact_id=$3,updated_at=now() WHERE tenant_id=$1 AND id=$2',
				[tenantId, row.id, targetId]
			);
		for (const row of references.activities)
			await client.query('UPDATE activities SET contact_id=$3 WHERE tenant_id=$1 AND id=$2', [
				tenantId,
				row.id,
				targetId
			]);
		for (const row of references.methods)
			await client.query('UPDATE contact_methods SET contact_id=$3 WHERE tenant_id=$1 AND id=$2', [
				tenantId,
				row.id,
				targetId
			]);
		for (const row of references.files)
			await client.query('UPDATE file_objects SET contact_id=$3 WHERE tenant_id=$1 AND id=$2', [
				tenantId,
				row.id,
				targetId
			]);
		const recordsAfter = references.records.map((row) =>
			replaceContactRef(row, sourceId, targetId)
		);
		for (const row of recordsAfter)
			await client.query(
				'UPDATE workspace_records SET data=$4,updated_at=now() WHERE tenant_id=$1 AND resource=$2 AND id=$3',
				[tenantId, row.resource, row.id, row.data]
			);
		const targetData = {
			...((source.data as Record<string, unknown>) || {}),
			...((target.data as Record<string, unknown>) || {})
		};
		await client.query('UPDATE contacts SET email=NULL WHERE tenant_id=$1 AND id=$2', [
			tenantId,
			sourceId
		]);
		const targetUpdated = await client.query(
			`UPDATE contacts SET email=COALESCE(email,$3),tags=ARRAY(SELECT DISTINCT unnest(tags||$4::text[])),data=$5,updated_at=now()
      WHERE tenant_id=$1 AND id=$2 RETURNING updated_at`,
			[tenantId, targetId, source.email, source.tags, targetData]
		);
		await client.query(
			'UPDATE contacts SET archived_at=now(),merged_into=$3,updated_at=now() WHERE tenant_id=$1 AND id=$2',
			[tenantId, sourceId, targetId]
		);
		const refsAfter = {
			tasks: references.tasks.map((row: any) => ({ ...row, contact_id: targetId })),
			activities: references.activities.map((row: any) => ({ ...row, contact_id: targetId })),
			methods: references.methods.map((row: any) => ({ ...row, contact_id: targetId })),
			records: recordsAfter,
			files: references.files.map((row: any) => ({ ...row, contact_id: targetId }))
		};
		const history = await client.query(
			`INSERT INTO contact_merge_history(tenant_id,source_contact_id,target_contact_id,actor_id,source_before,target_before,target_after_updated_at,references_before,references_after)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id,created_at`,
			[
				tenantId,
				sourceId,
				targetId,
				userId,
				sourceBefore,
				targetBefore,
				targetUpdated.rows[0].updated_at,
				references,
				refsAfter
			]
		);
		await client.query(
			'INSERT INTO audit_log(tenant_id,actor_id,action,resource,record_id,details) VALUES($1,$2,$3,$4,$5,$6)',
			[
				tenantId,
				userId,
				'contact.merged',
				'contacts',
				sourceId,
				{ targetId, mergeId: history.rows[0].id }
			]
		);
		await client.query(
			'INSERT INTO outbox_events(tenant_id,event_type,payload,idempotency_key) VALUES($1,$2,$3,$4)',
			[
				tenantId,
				'contact.merged',
				{ sourceId, targetId, mergeId: history.rows[0].id },
				`contact.merged:${tenantId}:${history.rows[0].id}`
			]
		);
		await client.query('COMMIT');
		return {
			mergeId: history.rows[0].id,
			sourceId,
			targetId,
			mergedAt: history.rows[0].created_at
		};
	} catch (error) {
		await client.query('ROLLBACK');
		throw error;
	} finally {
		client.release();
	}
}
export async function undoPostgresContactMerge(slug: string, userId: string, mergeId: string) {
	const { client, tenantId } = await beginContactMerge(slug, userId);
	try {
		const history = await client.query(
			'SELECT * FROM contact_merge_history WHERE tenant_id=$1 AND id=$2 FOR UPDATE',
			[tenantId, mergeId]
		);
		if (!history.rowCount)
			throw Object.assign(new Error('Merge history was not found in the active workspace.'), {
				status: 404
			});
		const merge = history.rows[0];
		if (merge.undone_at)
			throw Object.assign(new Error('This contact merge has already been undone.'), {
				status: 409
			});
		const target = await client.query(
			'SELECT updated_at,merged_into,archived_at FROM contacts WHERE tenant_id=$1 AND id=$2 FOR UPDATE',
			[tenantId, merge.target_contact_id]
		);
		const source = await client.query(
			'SELECT merged_into FROM contacts WHERE tenant_id=$1 AND id=$2 FOR UPDATE',
			[tenantId, merge.source_contact_id]
		);
		if (
			!target.rowCount ||
			!source.rowCount ||
			source.rows[0].merged_into !== merge.target_contact_id
		)
			throw Object.assign(new Error('The merged contact state has changed since this operation.'), {
				status: 409
			});
		if (
			new Date(target.rows[0].updated_at).getTime() !==
			new Date(merge.target_after_updated_at).getTime()
		)
			throw Object.assign(
				new Error('The target contact changed after this merge; undo is unsafe.'),
				{ status: 409 }
			);
		const restore = (snapshot: Record<string, any>) => [
			snapshot.name,
			snapshot.email,
			snapshot.stage,
			snapshot.tags,
			snapshot.data,
			snapshot.archived_at,
			snapshot.merged_into
		];
		await client.query(
			'UPDATE contacts SET name=$3,email=$4,stage=$5,tags=$6,data=$7,archived_at=$8,merged_into=$9,updated_at=now() WHERE tenant_id=$1 AND id=$2',
			[tenantId, merge.target_contact_id, ...restore(merge.target_before)]
		);
		await client.query(
			'UPDATE contacts SET name=$3,email=$4,stage=$5,tags=$6,data=$7,archived_at=$8,merged_into=$9,updated_at=now() WHERE tenant_id=$1 AND id=$2',
			[tenantId, merge.source_contact_id, ...restore(merge.source_before)]
		);
		const refs = merge.references_before as {
			tasks: Array<any>;
			activities: Array<any>;
			methods: Array<any>;
			records: Array<any>;
			files: Array<any>;
		};
		await assertMergeReferencesUnchanged(
			client,
			tenantId,
			merge.references_after as Record<string, any>
		);
		for (const row of refs.tasks)
			await client.query(
				'UPDATE tasks SET contact_id=$3,updated_at=now() WHERE tenant_id=$1 AND id=$2',
				[tenantId, row.id, row.contact_id]
			);
		for (const row of refs.activities)
			await client.query('UPDATE activities SET contact_id=$3 WHERE tenant_id=$1 AND id=$2', [
				tenantId,
				row.id,
				row.contact_id
			]);
		for (const row of refs.methods)
			await client.query('UPDATE contact_methods SET contact_id=$3 WHERE tenant_id=$1 AND id=$2', [
				tenantId,
				row.id,
				row.contact_id
			]);
		for (const row of refs.files)
			await client.query('UPDATE file_objects SET contact_id=$3 WHERE tenant_id=$1 AND id=$2', [
				tenantId,
				row.id,
				row.contact_id
			]);
		for (const row of refs.records)
			await client.query(
				'UPDATE workspace_records SET data=$4,updated_at=now() WHERE tenant_id=$1 AND resource=$2 AND id=$3',
				[tenantId, row.resource, row.id, row.data]
			);
		await client.query(
			'UPDATE contact_merge_history SET undone_at=now() WHERE tenant_id=$1 AND id=$2',
			[tenantId, mergeId]
		);
		await client.query(
			'INSERT INTO audit_log(tenant_id,actor_id,action,resource,record_id,details) VALUES($1,$2,$3,$4,$5,$6)',
			[
				tenantId,
				userId,
				'contact.merge_undone',
				'contacts',
				merge.source_contact_id,
				{ targetId: merge.target_contact_id, mergeId }
			]
		);
		await client.query(
			'INSERT INTO outbox_events(tenant_id,event_type,payload,idempotency_key) VALUES($1,$2,$3,$4)',
			[
				tenantId,
				'contact.merge_undone',
				{ sourceId: merge.source_contact_id, targetId: merge.target_contact_id, mergeId },
				`contact.merge_undone:${tenantId}:${mergeId}`
			]
		);
		await client.query('COMMIT');
		return {
			mergeId,
			sourceId: merge.source_contact_id,
			targetId: merge.target_contact_id,
			undone: true
		};
	} catch (error) {
		await client.query('ROLLBACK');
		throw error;
	} finally {
		client.release();
	}
}

export async function findExistingContactEmailsPostgres(
	slug: string,
	userId: string,
	candidates: string[]
) {
	const p = getPool();
	const tenant = await p.query('SELECT id FROM tenants WHERE slug=$1 AND suspended_at IS NULL', [
		slug
	]);
	if (!tenant.rowCount) throw Object.assign(new Error('Tenant not found.'), { status: 404 });
	const client = await p.connect();
	try {
		await client.query('BEGIN');
		await client.query("SELECT set_config('app.tenant_id',$1,true)", [tenant.rows[0].id]);
		const membership = await client.query(
			"SELECT m.role FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.tenant_id=$1 AND m.user_id=$2 AND m.status='active' AND u.disabled_at IS NULL",
			[tenant.rows[0].id, userId]
		);
		if (!membership.rowCount)
			throw Object.assign(new Error('Your tenant membership is no longer active.'), {
				status: 403
			});
		if (!exportRoles.has(membership.rows[0].role as string))
			throw Object.assign(new Error('Your role cannot import contacts.'), { status: 403 });
		const found = candidates.length
			? await client.query(
					'SELECT lower(email) AS email FROM contacts WHERE tenant_id=$1 AND lower(email)=ANY($2::text[])',
					[tenant.rows[0].id, candidates]
				)
			: { rows: [] };
		await client.query(
			'INSERT INTO audit_log(tenant_id,actor_id,action,resource,details) VALUES($1,$2,$3,$4,$5)',
			[
				tenant.rows[0].id,
				userId,
				'contacts.import.preview',
				'contacts',
				{ candidateCount: candidates.length }
			]
		);
		await client.query('COMMIT');
		return found.rows.map((row) => row.email as string);
	} catch (error) {
		await client.query('ROLLBACK');
		throw error;
	} finally {
		client.release();
	}
}

export async function importContactsPostgres(
	slug: string,
	userId: string,
	contacts: Array<Record<string, unknown>>
) {
	const p = getPool();
	const tenantResult = await p.query(
		'SELECT id FROM tenants WHERE slug=$1 AND suspended_at IS NULL',
		[slug]
	);
	if (!tenantResult.rowCount) throw new Error('Tenant not found');
	const tenantId = tenantResult.rows[0].id as string;
	const client = await p.connect();
	try {
		await client.query('BEGIN');
		await client.query("SELECT set_config('app.tenant_id',$1,true)", [tenantId]);
		const membership = await client.query(
			"SELECT m.role FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.tenant_id=$1 AND m.user_id=$2 AND m.status='active' AND u.disabled_at IS NULL",
			[tenantId, userId]
		);
		if (!membership.rowCount)
			throw Object.assign(new Error('Your tenant membership is no longer active.'), {
				status: 403
			});
		const role = membership.rows[0].role as string;
		if (!['owner', 'admin', 'fundraising_manager', 'fundraiser'].includes(role))
			throw Object.assign(new Error('Your role cannot import contacts.'), { status: 403 });
		const existing = await client.query(
			'SELECT lower(email) AS email FROM contacts WHERE tenant_id=$1 AND email IS NOT NULL',
			[tenantId]
		);
		const seen = new Set<string>(existing.rows.map((row) => row.email as string));
		for (const contact of contacts) {
			const email = String(contact.email || '').toLowerCase();
			if (email && seen.has(email))
				throw Object.assign(
					new Error(
						'Contact list changed after preview; no records were imported. Review duplicate rows and retry.'
					),
					{ status: 409 }
				);
			if (email) seen.add(email);
		}
		const created: Array<Record<string, unknown>> = [];
		for (const contact of contacts) {
			const id = crypto.randomUUID();
			const normalized: Record<string, unknown> = {
				...contact,
				email: contact.email ? String(contact.email).toLowerCase() : ''
			};
			await client.query(
				'INSERT INTO contacts(tenant_id,id,name,email,stage,tags,data) VALUES($1,$2,$3,$4,$5,$6,$7)',
				[
					tenantId,
					id,
					normalized.name,
					normalized.email || null,
					normalized.stage || 'new',
					normalized.tags || [],
					normalized
				]
			);
			await client.query(
				'INSERT INTO audit_log(tenant_id,actor_id,action,resource,record_id,details) VALUES($1,$2,$3,$4,$5,$6)',
				[tenantId, userId, 'contact.imported', 'contacts', id, { source: 'csv' }]
			);
			await client.query(
				'INSERT INTO outbox_events(tenant_id,event_type,payload,idempotency_key) VALUES($1,$2,$3,$4) ON CONFLICT(idempotency_key) DO NOTHING',
				[
					tenantId,
					'contact.created',
					{ recordId: id, source: 'csv' },
					`contact.created:${tenantId}:${id}`
				]
			);
			created.push({ ...normalized, id, createdAt: new Date().toISOString() });
		}
		await client.query('COMMIT');
		return created;
	} catch (error) {
		await client.query('ROLLBACK');
		throw error;
	} finally {
		client.release();
	}
}
