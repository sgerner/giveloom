import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { getPool, type SessionClaims } from './database';
import { getPublicTenantBranding } from './branding';
import { env } from '$env/dynamic/private';

const editorRoles = new Set(['owner', 'admin', 'fundraising_manager', 'fundraiser']);
const uuid = z.string().uuid();
const slugSchema = z
	.string()
	.trim()
	.min(3)
	.max(72)
	.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const receiptTemplateSchema = z
	.object({
		thankYouMessage: z.string().trim().max(500).default('Thank you for supporting our work.'),
		disclaimer: z
			.string()
			.trim()
			.min(12)
			.max(500)
			.default(
				'Donation acknowledgment only. This is not tax advice or a determination of deductibility.'
			)
	})
	.strict()
	.default(() => ({
		thankYouMessage: 'Thank you for supporting our work.',
		disclaimer:
			'Donation acknowledgment only. This is not tax advice or a determination of deductibility.'
	}));
const formSchema = z
	.object({
		frequencies: z
			.array(z.enum(['once', 'monthly', 'annual']))
			.min(1)
			.max(3),
		suggestedAmounts: z.array(z.number().int().min(50).max(25_000_000)).min(1).max(8),
		allowCustomAmount: z.boolean(),
		askForAddress: z.boolean(),
		allowAnonymous: z.boolean().default(true),
		allowTribute: z.boolean().default(true),
		allowFeeCoverage: z.boolean().default(false),
		feeCoverageBasisPoints: z.number().int().min(0).max(3000).default(0),
		feeCoverageFixedMinor: z.number().int().min(0).max(500).default(0),
		allowDesignation: z.boolean().default(false),
		designationFundIds: z.array(uuid).max(25).default([]),
		terms: z.string().trim().min(8).max(1000),
		privacyUrl: z.string().url().max(500).optional().or(z.literal(''))
	})
	.strict();
const campaignSchema = z
	.object({
		name: z.string().trim().min(3).max(140),
		publicSlug: slugSchema,
		description: z.string().trim().min(8).max(2400),
		story: z.string().trim().min(40).max(20_000),
		goalMinor: z.number().int().min(0).max(100_000_000_000),
		currency: z.string().regex(/^[A-Z]{3}$/),
		fundId: uuid.nullable().optional(),
		appealId: uuid.nullable().optional(),
		startsAt: z.string().datetime().nullable().default(null),
		endsAt: z.string().datetime().nullable().default(null),
		budgetMinor: z.number().int().min(0).max(100_000_000_000).default(0),
		channels: z
			.array(z.enum(['web', 'email', 'social', 'direct_mail', 'event', 'partner', 'other']))
			.max(8)
			.default([]),
		audienceSegments: z
			.array(
				z.enum([
					'new_donors',
					'recurring_donors',
					'lapsed_donors',
					'volunteers',
					'event_attendees',
					'community',
					'major_givers'
				])
			)
			.max(7)
			.default([]),
		utmSource: z.string().trim().max(80).default(''),
		utmMedium: z.string().trim().max(80).default(''),
		utmCampaign: z.string().trim().max(80).default(''),
		heroImageFileId: uuid.nullable().default(null),
		receiptTemplate: receiptTemplateSchema,
		formConfig: formSchema,
		acceptsOnlineGifts: z.boolean()
	})
	.strict();

export type CampaignDraft = z.infer<typeof campaignSchema>;
export class CampaignError extends Error {
	constructor(
		message: string,
		readonly status = 400
	) {
		super(message);
		this.name = 'CampaignError';
	}
}

function activeSession(session: SessionClaims | null | undefined, tenant?: string, write = false) {
	if (!session) throw new CampaignError('Sign in before accessing campaign data.', 401);
	if (session.demo)
		throw new CampaignError(
			'Campaign management requires persistent storage and is unavailable in demo mode.',
			503
		);
	if (tenant && tenant !== session.tenantSlug)
		throw new CampaignError('Tenant access denied.', 403);
	if (write && !editorRoles.has(session.role))
		throw new CampaignError('Your role cannot manage campaigns.', 403);
	return session;
}

async function tenantTransaction<T>(
	slug: string,
	task: (client: import('pg').PoolClient, tenantId: string) => Promise<T>
): Promise<T> {
	const pool = getPool();
	const tenant = await pool.query('SELECT id FROM tenants WHERE slug=$1', [slug]);
	if (!tenant.rowCount) throw new CampaignError('Workspace not found.', 404);
	const client = await pool.connect();
	try {
		await client.query('BEGIN');
		await client.query("SELECT set_config('app.tenant_id',$1,true)", [tenant.rows[0].id]);
		const result = await task(client, String(tenant.rows[0].id));
		await client.query('COMMIT');
		return result;
	} catch (error) {
		await client.query('ROLLBACK');
		throw error;
	} finally {
		client.release();
	}
}

async function validateDesignationFunds(
	client: import('pg').PoolClient,
	tenantId: string,
	form: z.infer<typeof formSchema>
) {
	if (!form.allowDesignation && form.designationFundIds.length)
		throw new CampaignError('Remove designation funds or enable donor designation.', 422);
	if (!form.designationFundIds.length) return;
	const result = await client.query(
		'SELECT id FROM funds WHERE tenant_id=$1 AND active=true AND id=ANY($2::uuid[])',
		[tenantId, form.designationFundIds]
	);
	if (result.rowCount !== form.designationFundIds.length)
		throw new CampaignError('Every designated fund must be active in this workspace.', 422);
}

function snapshotFromRow(row: Record<string, any>): CampaignDraft {
	// Legacy rows may predate published-form requirements. Editing must remain
	// available; save and publish still validate the complete draft contract.
	return {
		name: String(row.name),
		publicSlug: row.public_slug || `campaign-${row.id}`,
		description: row.data?.description || '',
		story: row.story || row.data?.story || '',
		goalMinor: Number(row.goal_minor),
		currency: String(row.currency).trim(),
		fundId: row.fund_id || null,
		appealId: row.appeal_id || null,
		startsAt: row.starts_at ? new Date(row.starts_at).toISOString() : null,
		endsAt: row.ends_at ? new Date(row.ends_at).toISOString() : null,
		budgetMinor: Number(row.budget_minor || 0),
		channels: row.channels || [],
		audienceSegments: row.audience_segments || [],
		utmSource: row.utm_source || '',
		utmMedium: row.utm_medium || '',
		utmCampaign: row.utm_campaign || '',
		heroImageFileId: row.hero_file_id || null,
		receiptTemplate: row.receipt_template || {},
		formConfig: {
			frequencies: ['once'],
			suggestedAmounts: [2500, 5000, 10000, 25000],
			allowCustomAmount: true,
			askForAddress: false,
			terms: '',
			privacyUrl: '',
			...(row.form_config || {})
		},
		acceptsOnlineGifts: row.data?.acceptsOnlineGifts !== false
	};
}

export async function listFunds(session: SessionClaims | null | undefined) {
	const current = activeSession(session);
	return tenantTransaction(current.tenantSlug, async (client) => {
		const result = await client.query(
			'SELECT id,name,slug,code,description,restricted,active FROM funds WHERE active ORDER BY name'
		);
		return result.rows;
	});
}

export async function saveFund(session: SessionClaims | null | undefined, input: unknown) {
	const current = activeSession(session, undefined, true);
	const body = z
		.object({
			name: z.string().trim().min(2).max(140),
			slug: slugSchema,
			code: z.string().trim().max(32).optional().or(z.literal('')),
			description: z.string().trim().max(1000).default(''),
			restricted: z.boolean().default(false)
		})
		.strict()
		.parse(input);
	return tenantTransaction(current.tenantSlug, async (client, tenantId) => {
		const result = await client.query(
			'INSERT INTO funds(tenant_id,name,slug,code,description,restricted) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,name,slug,code,description,restricted,active',
			[tenantId, body.name, body.slug, body.code || null, body.description, body.restricted]
		);
		await client.query(
			'INSERT INTO audit_log(tenant_id,actor_id,action,resource,record_id,details) VALUES($1,$2,$3,$4,$5,$6)',
			[tenantId, current.userId, 'fund.created', 'funds', result.rows[0].id, { name: body.name }]
		);
		return result.rows[0];
	});
}

export async function listAppeals(session: SessionClaims | null | undefined) {
	const current = activeSession(session);
	return tenantTransaction(
		current.tenantSlug,
		async (client) =>
			(
				await client.query(
					'SELECT id,fund_id AS "fundId",name,slug,description,starts_at AS "startsAt",ends_at AS "endsAt",active FROM appeals WHERE active ORDER BY name'
				)
			).rows
	);
}

export async function saveAppeal(session: SessionClaims | null | undefined, input: unknown) {
	const current = activeSession(session, undefined, true);
	const body = z
		.object({
			name: z.string().trim().min(2).max(140),
			slug: slugSchema,
			fundId: uuid.nullable().optional(),
			description: z.string().trim().max(1000).default(''),
			startsAt: z.string().datetime().optional(),
			endsAt: z.string().datetime().optional()
		})
		.strict()
		.parse(input);
	return tenantTransaction(current.tenantSlug, async (client, tenantId) => {
		const row = await client.query(
			'INSERT INTO appeals(tenant_id,fund_id,name,slug,description,starts_at,ends_at) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id,fund_id AS "fundId",name,slug,description,starts_at AS "startsAt",ends_at AS "endsAt",active',
			[
				tenantId,
				body.fundId || null,
				body.name,
				body.slug,
				body.description,
				body.startsAt || null,
				body.endsAt || null
			]
		);
		await client.query(
			'INSERT INTO audit_log(tenant_id,actor_id,action,resource,record_id,details) VALUES($1,$2,$3,$4,$5,$6)',
			[tenantId, current.userId, 'appeal.created', 'appeals', row.rows[0].id, { name: body.name }]
		);
		return row.rows[0];
	});
}

export async function listCampaigns(session: SessionClaims | null | undefined) {
	const current = activeSession(session);
	return tenantTransaction(current.tenantSlug, async (client) => {
		const result = await client.query(
			`SELECT c.id,c.name,c.public_slug AS "publicSlug",c.goal_minor AS "goalMinor",c.currency,c.status,c.version,coalesce(d.version,c.version) AS "draftVersion",c.published_at AS "publishedAt",f.name AS "fundName",a.name AS "appealName" FROM campaigns c LEFT JOIN campaign_drafts d ON d.tenant_id=c.tenant_id AND d.campaign_id=c.id LEFT JOIN funds f ON f.tenant_id=c.tenant_id AND f.id=c.fund_id LEFT JOIN appeals a ON a.tenant_id=c.tenant_id AND a.id=c.appeal_id ORDER BY c.updated_at DESC`
		);
		return result.rows;
	});
}

export async function getCampaign(session: SessionClaims | null | undefined, id: string) {
	const current = activeSession(session);
	if (!uuid.safeParse(id).success) throw new CampaignError('Campaign not found.', 404);
	return tenantTransaction(current.tenantSlug, async (client) => {
		const result = await client.query(
			`SELECT c.*,d.snapshot AS draft_snapshot,d.version AS draft_version FROM campaigns c LEFT JOIN campaign_drafts d ON d.tenant_id=c.tenant_id AND d.campaign_id=c.id WHERE c.id=$1`,
			[id]
		);
		if (!result.rowCount) throw new CampaignError('Campaign not found.', 404);
		const row = result.rows[0];
		return {
			id: row.id,
			status: row.status,
			publishedAt: row.published_at,
			version: Number(row.draft_version || row.version),
			draft: row.draft_snapshot || snapshotFromRow(row)
		};
	});
}

export async function createCampaign(session: SessionClaims | null | undefined, input: unknown) {
	const current = activeSession(session, undefined, true);
	const body = campaignSchema.parse(input);
	return tenantTransaction(current.tenantSlug, async (client, tenantId) => {
		await validateDesignationFunds(client, tenantId, body.formConfig);
		const id = randomUUID();
		const result = await client.query(
			`INSERT INTO campaigns(tenant_id,id,name,goal_minor,currency,status,data,story,form_config,fund_id,appeal_id,starts_at,ends_at,budget_minor,channels,audience_segments,utm_source,utm_medium,utm_campaign,hero_file_id,receipt_template,version) VALUES($1,$2,$3,$4,$5,'draft',$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,1) RETURNING id`,
			[
				tenantId,
				id,
				body.name,
				body.goalMinor,
				body.currency,
				{ description: body.description, acceptsOnlineGifts: body.acceptsOnlineGifts },
				body.story,
				body.formConfig,
				body.fundId || null,
				body.appealId || null,
				body.startsAt,
				body.endsAt,
				body.budgetMinor,
				body.channels,
				body.audienceSegments,
				body.utmSource,
				body.utmMedium,
				body.utmCampaign,
				body.heroImageFileId,
				body.receiptTemplate
			]
		);
		const snapshot = { ...body, fundId: body.fundId || null, appealId: body.appealId || null };
		await client.query(
			'INSERT INTO campaign_drafts(tenant_id,campaign_id,version,snapshot,actor_id) VALUES($1,$2,1,$3,$4)',
			[tenantId, id, snapshot, current.userId]
		);
		await client.query(
			'INSERT INTO campaign_versions(tenant_id,campaign_id,version,snapshot,actor_id) VALUES($1,$2,1,$3,$4)',
			[tenantId, id, snapshot, current.userId]
		);
		await client.query(
			'INSERT INTO audit_log(tenant_id,actor_id,action,resource,record_id,details) VALUES($1,$2,$3,$4,$5,$6)',
			[
				tenantId,
				current.userId,
				'campaign.created',
				'campaigns',
				result.rows[0].id,
				{ name: body.name }
			]
		);
		return { id, status: 'draft', version: 1, draft: snapshot };
	});
}

export async function saveCampaignDraft(
	session: SessionClaims | null | undefined,
	id: string,
	input: unknown
) {
	const current = activeSession(session, undefined, true);
	if (!uuid.safeParse(id).success) throw new CampaignError('Campaign not found.', 404);
	const body = z
		.object({ expectedVersion: z.number().int().min(1), draft: campaignSchema })
		.strict()
		.parse(input);
	return tenantTransaction(current.tenantSlug, async (client, tenantId) => {
		await validateDesignationFunds(client, tenantId, body.draft.formConfig);
		const locked = await client.query(
			'SELECT version FROM campaign_drafts WHERE tenant_id=$1 AND campaign_id=$2 FOR UPDATE',
			[tenantId, id]
		);
		if (!locked.rowCount) throw new CampaignError('Campaign not found.', 404);
		const version = Number(locked.rows[0].version);
		if (version !== body.expectedVersion)
			throw new CampaignError(
				'This draft changed in another editor. Reload the latest version before saving.',
				409
			);
		const next = version + 1;
		const snapshot = {
			...body.draft,
			fundId: body.draft.fundId || null,
			appealId: body.draft.appealId || null
		};
		await client.query(
			'UPDATE campaign_drafts SET version=$3,snapshot=$4,actor_id=$5,updated_at=now() WHERE tenant_id=$1 AND campaign_id=$2',
			[tenantId, id, next, snapshot, current.userId]
		);
		await client.query(
			'UPDATE campaigns SET version=$3,updated_at=now() WHERE tenant_id=$1 AND id=$2',
			[tenantId, id, next]
		);
		await client.query(
			'INSERT INTO campaign_versions(tenant_id,campaign_id,version,snapshot,actor_id) VALUES($1,$2,$3,$4,$5)',
			[tenantId, id, next, snapshot, current.userId]
		);
		await client.query(
			'INSERT INTO audit_log(tenant_id,actor_id,action,resource,record_id,details) VALUES($1,$2,$3,$4,$5,$6)',
			[tenantId, current.userId, 'campaign.draft.saved', 'campaigns', id, { version: next }]
		);
		return { version: next, draft: snapshot };
	});
}

export async function campaignVersions(session: SessionClaims | null | undefined, id: string) {
	const current = activeSession(session);
	return tenantTransaction(
		current.tenantSlug,
		async (client) =>
			(
				await client.query(
					'SELECT version,snapshot,actor_id AS "actorId",created_at AS "createdAt" FROM campaign_versions WHERE campaign_id=$1 ORDER BY version DESC LIMIT 50',
					[id]
				)
			).rows
	);
}

export async function publishCampaign(session: SessionClaims | null | undefined, id: string) {
	const current = activeSession(session, undefined, true);
	return tenantTransaction(current.tenantSlug, async (client, tenantId) => {
		const row = await client.query(
			'SELECT d.version,d.snapshot FROM campaign_drafts d JOIN campaigns c ON c.tenant_id=d.tenant_id AND c.id=d.campaign_id WHERE d.tenant_id=$1 AND d.campaign_id=$2 FOR UPDATE OF d',
			[tenantId, id]
		);
		if (!row.rowCount) throw new CampaignError('Campaign not found.', 404);
		const draft = campaignSchema.parse(row.rows[0].snapshot);
		await validateDesignationFunds(client, tenantId, draft.formConfig);
		if (!draft.name || !draft.description || !draft.story || !draft.publicSlug)
			throw new CampaignError(
				'Add a name, public address, description, and story before publishing.',
				422
			);
		if (!draft.formConfig.terms.trim())
			throw new CampaignError(
				'Add clear authorization terms to the donation form before publishing.',
				422
			);
		if (draft.startsAt && draft.endsAt && Date.parse(draft.endsAt) <= Date.parse(draft.startsAt))
			throw new CampaignError('Campaign end must be after its start.', 422);
		if (draft.startsAt && Date.parse(draft.startsAt) < Date.now() - 60_000)
			throw new CampaignError('Campaign start must be in the future or left blank.', 422);
		if (draft.endsAt && Date.parse(draft.endsAt) <= Date.now())
			throw new CampaignError('Campaign end must be in the future.', 422);
		if (draft.heroImageFileId) {
			const hero = await client.query(
				'SELECT media_type,scan_status,size_bytes FROM file_objects WHERE tenant_id=$1 AND id=$2',
				[tenantId, draft.heroImageFileId]
			);
			if (
				!hero.rowCount ||
				!['image/jpeg', 'image/png', 'image/webp'].includes(hero.rows[0].media_type) ||
				Number(hero.rows[0].size_bytes) > 5_242_880 ||
				(process.env.NODE_ENV === 'production' && hero.rows[0].scan_status !== 'clean')
			)
				throw new CampaignError('Choose a safe, scanned campaign image no larger than 5 MiB.', 422);
		}
		if (draft.acceptsOnlineGifts) {
			const secret = env.STRIPE_PLATFORM_SECRET_KEY || '';
			const publishable = env.STRIPE_CONNECT_PUBLISHABLE_KEY || '';
			if (
				!secret ||
				!/^pk_(live|test)_[A-Za-z0-9]+$/.test(publishable) ||
				secret.startsWith('sk_live_') !== publishable.startsWith('pk_live_')
			)
				throw new CampaignError(
					'Configure matching Stripe platform and connected-account keys before publishing online donations.',
					422
				);
			const account = await client.query(
				'SELECT livemode FROM stripe_accounts WHERE tenant_id=$1 AND enabled=true AND disconnected_at IS NULL',
				[tenantId]
			);
			if (!account.rowCount || account.rows[0].livemode !== secret.startsWith('sk_live_'))
				throw new CampaignError(
					'Connect an active Stripe account in the configured payment mode before publishing online donations.',
					422
				);
		}
		const nextStatus =
			draft.startsAt && Date.parse(draft.startsAt) > Date.now() ? 'scheduled' : 'published';
		const updated = await client.query(
			`UPDATE campaigns SET name=$3,public_slug=$4,goal_minor=$5,currency=$6,story=$7,form_config=$8,fund_id=$9,appeal_id=$10,data=data||$11,starts_at=$12,ends_at=$13,budget_minor=$14,channels=$15,audience_segments=$16,utm_source=$17,utm_medium=$18,utm_campaign=$19,hero_file_id=$20,receipt_template=$21,status=$22,published_at=CASE WHEN $22='published' THEN now() ELSE NULL END,updated_at=now(),version=$23 WHERE tenant_id=$1 AND id=$2 RETURNING id,name,public_slug AS "publicSlug",status,published_at AS "publishedAt",version`,
			[
				tenantId,
				id,
				draft.name,
				draft.publicSlug,
				draft.goalMinor,
				draft.currency,
				draft.story,
				draft.formConfig,
				draft.fundId || null,
				draft.appealId || null,
				{ description: draft.description, acceptsOnlineGifts: draft.acceptsOnlineGifts },
				draft.startsAt,
				draft.endsAt,
				draft.budgetMinor,
				draft.channels,
				draft.audienceSegments,
				draft.utmSource,
				draft.utmMedium,
				draft.utmCampaign,
				draft.heroImageFileId,
				draft.receiptTemplate,
				nextStatus,
				row.rows[0].version
			]
		);
		await client.query(
			'INSERT INTO audit_log(tenant_id,actor_id,action,resource,record_id,details) VALUES($1,$2,$3,$4,$5,$6)',
			[
				tenantId,
				current.userId,
				'campaign.published',
				'campaigns',
				id,
				{ version: Number(row.rows[0].version), publicSlug: draft.publicSlug }
			]
		);
		return updated.rows[0];
	});
}

export async function pauseCampaign(session: SessionClaims | null | undefined, id: string) {
	const current = activeSession(session, undefined, true);
	return tenantTransaction(current.tenantSlug, async (client, tenantId) => {
		const result = await client.query(
			"UPDATE campaigns SET status='paused',updated_at=now() WHERE tenant_id=$1 AND id=$2 AND status IN ('published','scheduled') RETURNING id,status",
			[tenantId, id]
		);
		if (!result.rowCount)
			throw new CampaignError('Only a published or scheduled campaign can be paused.', 409);
		await client.query(
			"INSERT INTO audit_log(tenant_id,actor_id,action,resource,record_id) VALUES($1,$2,'campaign.paused','campaigns',$3)",
			[tenantId, current.userId, id]
		);
		return result.rows[0];
	});
}

export async function resumeCampaign(session: SessionClaims | null | undefined, id: string) {
	const current = activeSession(session, undefined, true);
	return tenantTransaction(current.tenantSlug, async (client, tenantId) => {
		const row = await client.query(
			"SELECT starts_at,ends_at FROM campaigns WHERE tenant_id=$1 AND id=$2 AND status='paused' FOR UPDATE",
			[tenantId, id]
		);
		if (!row.rowCount) throw new CampaignError('Paused campaign not found.', 404);
		if (row.rows[0].ends_at && new Date(row.rows[0].ends_at).getTime() <= Date.now())
			throw new CampaignError('This campaign has ended and cannot be resumed.', 422);
		const status =
			row.rows[0].starts_at && new Date(row.rows[0].starts_at).getTime() > Date.now()
				? 'scheduled'
				: 'published';
		const result = await client.query(
			'UPDATE campaigns SET status=$3,published_at=CASE WHEN $3=\'published\' THEN COALESCE(published_at,now()) ELSE NULL END,updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING id,status,published_at AS "publishedAt"',
			[tenantId, id, status]
		);
		await client.query(
			"INSERT INTO audit_log(tenant_id,actor_id,action,resource,record_id) VALUES($1,$2,'campaign.resumed','campaigns',$3)",
			[tenantId, current.userId, id]
		);
		return result.rows[0];
	});
}

export async function unpublishCampaign(session: SessionClaims | null | undefined, id: string) {
	const current = activeSession(session, undefined, true);
	return tenantTransaction(current.tenantSlug, async (client, tenantId) => {
		const result = await client.query(
			"UPDATE campaigns SET status='draft',published_at=NULL,updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING id,status",
			[tenantId, id]
		);
		if (!result.rowCount) throw new CampaignError('Campaign not found.', 404);
		await client.query(
			'INSERT INTO audit_log(tenant_id,actor_id,action,resource,record_id) VALUES($1,$2,$3,$4,$5)',
			[tenantId, current.userId, 'campaign.unpublished', 'campaigns', id]
		);
		return result.rows[0];
	});
}

export async function createVariant(
	session: SessionClaims | null | undefined,
	campaignId: string,
	input: unknown
) {
	const current = activeSession(session, undefined, true);
	const body = z
		.object({
			name: z.string().trim().min(1).max(80),
			weight: z.number().int().min(1).max(99),
			content: z
				.object({
					headline: z.string().trim().min(3).max(140),
					description: z.string().trim().max(600).default('')
				})
				.strict()
		})
		.strict()
		.parse(input);
	return tenantTransaction(current.tenantSlug, async (client, tenantId) => {
		const result = await client.query(
			'INSERT INTO campaign_variants(tenant_id,campaign_id,name,weight,content) SELECT $1,id,$3,$4,$5 FROM campaigns WHERE tenant_id=$1 AND id=$2 RETURNING id,name,weight,content,active,impressions,conversions',
			[tenantId, campaignId, body.name, body.weight, body.content]
		);
		if (!result.rowCount) throw new CampaignError('Campaign not found.', 404);
		return result.rows[0];
	});
}

export async function createCampaignLink(
	session: SessionClaims | null | undefined,
	campaignId: string,
	input: unknown
) {
	const current = activeSession(session, undefined, true);
	const body = z
		.object({
			label: z.string().trim().max(100).default(''),
			variantId: uuid.optional(),
			fundraiserId: uuid.optional()
		})
		.strict()
		.parse(input);
	return tenantTransaction(current.tenantSlug, async (client, tenantId) => {
		const code = randomBytes(9).toString('base64url');
		const result = await client.query(
			'INSERT INTO campaign_links(tenant_id,campaign_id,code,label,variant_id,fundraiser_id) SELECT $1,id,$3,$4,$5,$6 FROM campaigns WHERE tenant_id=$1 AND id=$2 RETURNING id,code,label,variant_id AS "variantId",fundraiser_id AS "fundraiserId",clicks',
			[tenantId, campaignId, code, body.label, body.variantId || null, body.fundraiserId || null]
		);
		if (!result.rowCount) throw new CampaignError('Campaign not found.', 404);
		return { ...result.rows[0], path: `/donate/${current.tenantSlug}/${campaignId}?ref=${code}` };
	});
}

export async function createFundraisingPage(
	session: SessionClaims | null | undefined,
	campaignId: string,
	input: unknown
) {
	const current = activeSession(session, undefined, true);
	const body = z
		.object({
			slug: slugSchema,
			pageType: z.enum(['individual', 'team']),
			name: z.string().trim().min(2).max(120),
			story: z.string().trim().min(10).max(4000),
			goalMinor: z.number().int().min(0).max(100_000_000_000),
			contactId: uuid.optional(),
			parentPageId: uuid.optional(),
			publish: z.boolean().default(false)
		})
		.strict()
		.parse(input);
	return tenantTransaction(current.tenantSlug, async (client, tenantId) => {
		if (body.pageType === 'individual' && !body.contactId)
			throw new CampaignError(
				'Choose a workspace contact to own an individual fundraising page.',
				422
			);
		const result = await client.query(
			`INSERT INTO fundraising_pages(tenant_id,campaign_id,slug,page_type,name,story,goal_minor,contact_id,parent_page_id,status,published_at) SELECT $1,id,$3,$4,$5,$6,$7,$8,$9,$10,CASE WHEN $10='published' THEN now() END FROM campaigns WHERE tenant_id=$1 AND id=$2 AND status='published' RETURNING id,slug,page_type AS "pageType",name,story,goal_minor AS "goalMinor",status`,
			[
				tenantId,
				campaignId,
				body.slug,
				body.pageType,
				body.name,
				body.story,
				body.goalMinor,
				body.contactId || null,
				body.parentPageId || null,
				body.publish ? 'published' : 'draft'
			]
		);
		if (!result.rowCount)
			throw new CampaignError(
				'Publish the parent campaign before creating a public fundraising page.',
				422
			);
		return result.rows[0];
	});
}

export async function publicCampaign(tenantSlug: string, publicSlug: string, ref?: string) {
	const pool = getPool();
	const tenant = await pool.query(
		'SELECT id,legal_name,currency FROM tenants WHERE slug=$1 AND suspended_at IS NULL',
		[tenantSlug]
	);
	if (!tenant.rowCount) return null;
	const branding = await getPublicTenantBranding(tenantSlug);
	return tenantTransaction(tenantSlug, async (client, tenantId) => {
		const campaign = await client.query(
			`SELECT id,name,public_slug AS "publicSlug",goal_minor AS "goalMinor",currency,story,form_config AS "formConfig",data->>'description' AS description,fund_id AS "fundId",appeal_id AS "appealId",hero_file_id AS "heroFileId",receipt_template AS "receiptTemplate" FROM campaigns WHERE tenant_id=$1 AND public_slug=$2 AND status IN ('published','active','scheduled') AND (starts_at IS NULL OR starts_at<=now()) AND (ends_at IS NULL OR ends_at>now())`,
			[tenantId, publicSlug]
		);
		if (!campaign.rowCount) return null;
		let linkedVariantId: string | null = null;
		if (ref) {
			const link = await client.query(
				'SELECT variant_id FROM campaign_links WHERE tenant_id=$1 AND campaign_id=$2 AND code=$3',
				[tenantId, campaign.rows[0].id, ref]
			);
			if (link.rowCount) {
				linkedVariantId = link.rows[0].variant_id;
				await client.query(
					'UPDATE campaign_links SET clicks=clicks+1 WHERE tenant_id=$1 AND campaign_id=$2 AND code=$3',
					[tenantId, campaign.rows[0].id, ref]
				);
			}
		}
		const variants = await client.query(
			'SELECT id,name,weight,content FROM campaign_variants WHERE tenant_id=$1 AND campaign_id=$2 AND active=true ORDER BY created_at',
			[tenantId, campaign.rows[0].id]
		);
		let variant = linkedVariantId
			? variants.rows.find((item) => String(item.id) === linkedVariantId) || null
			: null;
		if (!variant) {
			const weightTotal = variants.rows.reduce((sum, item) => sum + Number(item.weight), 0);
			let draw = Math.random() * weightTotal;
			variant = variants.rows.find((item) => (draw -= Number(item.weight)) < 0) || null;
		}
		if (variant)
			await client.query(
				'UPDATE campaign_variants SET impressions=impressions+1 WHERE tenant_id=$1 AND id=$2',
				[tenantId, variant.id]
			);
		return {
			organization: branding?.publicName || tenant.rows[0].legal_name,
			branding,
			tenant: tenantSlug,
			campaign: {
				...campaign.rows[0],
				heroImageUrl: campaign.rows[0].heroFileId
					? `/campaign-image/${encodeURIComponent(tenantSlug)}/${encodeURIComponent(String(campaign.rows[0].id))}`
					: null
			},
			variant: variant ? { id: variant.id, ...variant.content } : null
		};
	});
}

export async function publicFundraisingPage(tenantSlug: string, slug: string) {
	const pool = getPool();
	const tenant = await pool.query(
		'SELECT id,legal_name FROM tenants WHERE slug=$1 AND suspended_at IS NULL',
		[tenantSlug]
	);
	if (!tenant.rowCount) return null;
	const branding = await getPublicTenantBranding(tenantSlug);
	return tenantTransaction(tenantSlug, async (client, tenantId) => {
		const result = await client.query(
			`SELECT p.id,p.slug,p.page_type AS "pageType",p.name,p.story,p.goal_minor AS "goalMinor",c.id AS "campaignId",c.name AS "campaignName",c.public_slug AS "campaignSlug",coalesce((SELECT sum(g.amount_minor) FROM gifts g WHERE g.tenant_id=p.tenant_id AND g.fundraising_page_id=p.id AND g.status='recorded'),0) AS "raisedMinor" FROM fundraising_pages p JOIN campaigns c ON c.tenant_id=p.tenant_id AND c.id=p.campaign_id WHERE p.tenant_id=$1 AND p.slug=$2 AND p.status='published' AND c.status IN ('published','active','scheduled') AND (c.starts_at IS NULL OR c.starts_at<=now()) AND (c.ends_at IS NULL OR c.ends_at>now())`,
			[tenantId, slug]
		);
		return result.rowCount
			? {
					organization: branding?.publicName || tenant.rows[0].legal_name,
					branding,
					tenant: tenantSlug,
					...result.rows[0]
				}
			: null;
	});
}

export async function listCampaignFundraisers(
	session: SessionClaims | null | undefined,
	campaignId: string
) {
	const current = activeSession(session);
	return tenantTransaction(
		current.tenantSlug,
		async (client) =>
			(
				await client.query(
					'SELECT id,slug,page_type AS "pageType",name,story,goal_minor AS "goalMinor",status,contact_id AS "contactId",parent_page_id AS "parentPageId" FROM fundraising_pages WHERE campaign_id=$1 ORDER BY created_at DESC',
					[campaignId]
				)
			).rows
	);
}

export async function recordCampaignConversion(
	tenantSlug: string,
	campaignId: string,
	variantId?: string
) {
	return tenantTransaction(tenantSlug, async (client, tenantId) => {
		if (variantId)
			await client.query(
				'UPDATE campaign_variants SET conversions=conversions+1 WHERE tenant_id=$1 AND campaign_id=$2 AND id=$3 AND active=true',
				[tenantId, campaignId, variantId]
			);
	});
}

export function safePublicCampaignSlug(input: string) {
	return slugSchema.parse(input);
}
export function hashPublicReference(input: string) {
	return createHash('sha256').update(input).digest('hex');
}
