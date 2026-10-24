import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '$env/dynamic/private';
import Stripe from 'stripe';
import { getPool, type SessionClaims } from './database';

export class PaymentError extends Error {
	constructor(
		message: string,
		public status = 400
	) {
		super(message);
	}
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function platformKey() {
	return env.STRIPE_PLATFORM_SECRET_KEY || '';
}
function stripeClient() {
	const key = platformKey();
	if (!key) throw new PaymentError('Stripe is not configured.', 503);
	return new Stripe(key);
}
async function tenantIdBySlug(slug: string) {
	const result = await getPool().query(
		'SELECT id,slug,legal_name,currency FROM tenants WHERE slug=$1 AND suspended_at IS NULL',
		[slug]
	);
	if (!result.rowCount) throw new PaymentError('Workspace not found.', 404);
	return result.rows[0] as { id: string; slug: string; legal_name: string; currency: string };
}
async function requireManager(session: SessionClaims & { tenantSlug: string; userId: string }) {
	const tenant = await tenantIdBySlug(session.tenantSlug);
	const client = await getPool().connect();
	try {
		await client.query('BEGIN');
		await client.query("SELECT set_config('app.tenant_id',$1,true)", [tenant.id]);
		const member = await client.query(
			"SELECT role FROM memberships WHERE tenant_id=$1 AND user_id=$2 AND status='active'",
			[tenant.id, session.userId]
		);
		if (!member.rowCount) throw new PaymentError('Your tenant membership is not active.', 403);
		if (!['owner', 'admin'].includes(member.rows[0].role))
			throw new PaymentError('Only a workspace owner or admin can manage Stripe.', 403);
		await client.query('COMMIT');
		return tenant;
	} catch (error) {
		await client.query('ROLLBACK');
		throw error;
	} finally {
		client.release();
	}
}

export async function createStripeConnectState(
	session: SessionClaims & { tenantSlug: string; userId: string },
	state: string
) {
	const tenant = await requireManager(session);
	const client = await getPool().connect();
	try {
		await client.query('BEGIN');
		await client.query("SELECT set_config('app.tenant_id',$1,true)", [tenant.id]);
		await client.query(
			'DELETE FROM stripe_oauth_states WHERE tenant_id=$1 AND (expires_at<now() OR consumed_at IS NOT NULL)',
			[tenant.id]
		);
		await client.query(
			"INSERT INTO stripe_oauth_states(state_hash,tenant_id,user_id,expires_at) VALUES($1,$2,$3,now()+interval '10 minutes')",
			[hash(state), tenant.id, session.userId]
		);
		await client.query('COMMIT');
	} catch (error) {
		await client.query('ROLLBACK');
		throw error;
	} finally {
		client.release();
	}
}
export async function consumeStripeConnectState(
	session: SessionClaims & { tenantSlug: string; userId: string },
	state: string
) {
	const tenant = await tenantIdBySlug(session.tenantSlug);
	const client = await getPool().connect();
	try {
		await client.query('BEGIN');
		await client.query("SELECT set_config('app.tenant_id',$1,true)", [tenant.id]);
		const row = await client.query(
			`UPDATE stripe_oauth_states SET consumed_at=now() WHERE state_hash=$1 AND tenant_id=$2 AND user_id=$3 AND consumed_at IS NULL AND expires_at>now() RETURNING state_hash`,
			[hash(state), tenant.id, session.userId]
		);
		if (!row.rowCount)
			throw new PaymentError('Stripe authorization state expired or was already used.', 400);
		await client.query('COMMIT');
		return tenant;
	} catch (error) {
		await client.query('ROLLBACK');
		throw error;
	} finally {
		client.release();
	}
}
export async function saveStripeAccount(
	session: SessionClaims & { tenantSlug: string; userId: string },
	accountId: string,
	livemode: boolean
) {
	const tenant = await requireManager(session);
	const client = await getPool().connect();
	try {
		await client.query('BEGIN');
		await client.query("SELECT set_config('app.tenant_id',$1,true)", [tenant.id]);
		await client.query(
			`INSERT INTO stripe_accounts(tenant_id,connected_account_id,livemode,enabled,connected_by,connected_at,disconnected_at)
      VALUES($1,$2,$3,true,$4,now(),null)
      ON CONFLICT(tenant_id) DO UPDATE SET connected_account_id=EXCLUDED.connected_account_id,livemode=EXCLUDED.livemode,enabled=true,connected_by=EXCLUDED.connected_by,connected_at=now(),disconnected_at=null`,
			[tenant.id, accountId, livemode, session.userId]
		);
		await client.query(
			'INSERT INTO audit_log(tenant_id,actor_id,action,resource,details) VALUES($1,$2,$3,$4,$5)',
			[tenant.id, session.userId, 'stripe.connected', 'stripe_accounts', { accountId, livemode }]
		);
		await client.query('COMMIT');
	} catch (error) {
		await client.query('ROLLBACK');
		throw error;
	} finally {
		client.release();
	}
}
export async function disconnectStripeAccount(
	session: SessionClaims & { tenantSlug: string; userId: string }
) {
	const tenant = await requireManager(session);
	const client = await getPool().connect();
	try {
		await client.query('BEGIN');
		await client.query("SELECT set_config('app.tenant_id',$1,true)", [tenant.id]);
		const row = await client.query(
			'UPDATE stripe_accounts SET enabled=false,disconnected_at=now() WHERE tenant_id=$1 AND enabled=true RETURNING connected_account_id',
			[tenant.id]
		);
		await client.query(
			'INSERT INTO audit_log(tenant_id,actor_id,action,resource,details) VALUES($1,$2,$3,$4,$5)',
			[
				tenant.id,
				session.userId,
				'stripe.disconnected',
				'stripe_accounts',
				{ accountId: row.rows[0]?.connected_account_id || null }
			]
		);
		await client.query('COMMIT');
		return row.rows[0]?.connected_account_id as string | undefined;
	} catch (error) {
		await client.query('ROLLBACK');
		throw error;
	} finally {
		client.release();
	}
}
export async function publicStripeAccount(slug: string) {
	const tenant = await tenantIdBySlug(slug);
	const client = await getPool().connect();
	try {
		await client.query('BEGIN');
		await client.query("SELECT set_config('app.tenant_id',$1,true)", [tenant.id]);
		const account = await client.query(
			'SELECT connected_account_id,livemode FROM stripe_accounts WHERE tenant_id=$1 AND enabled=true AND disconnected_at IS NULL',
			[tenant.id]
		);
		await client.query('COMMIT');
		if (!account.rowCount)
			throw new PaymentError('Donations are not available for this workspace.', 404);
		const mode = platformKey().startsWith('sk_live_');
		if (account.rows[0].livemode !== mode)
			throw new PaymentError(
				'The connected Stripe account is not available in this payment mode.',
				503
			);
		return { tenant, connectedAccountId: account.rows[0].connected_account_id as string };
	} catch (error) {
		await client.query('ROLLBACK');
		throw error;
	} finally {
		client.release();
	}
}

export async function stripeAccountStatus(
	session: SessionClaims & { tenantSlug: string; userId: string }
) {
	const tenant = await tenantIdBySlug(session.tenantSlug);
	const client = await getPool().connect();
	try {
		await client.query('BEGIN');
		await client.query("SELECT set_config('app.tenant_id',$1,true)", [tenant.id]);
		const member = await client.query(
			"SELECT role FROM memberships WHERE tenant_id=$1 AND user_id=$2 AND status='active'",
			[tenant.id, session.userId]
		);
		if (!member.rowCount) throw new PaymentError('Your tenant membership is not active.', 403);
		const account = await client.query(
			'SELECT connected_account_id,livemode,enabled,connected_at,disconnected_at FROM stripe_accounts WHERE tenant_id=$1',
			[tenant.id]
		);
		await client.query('COMMIT');
		return {
			configured: Boolean(platformKey()),
			connected: Boolean(
				account.rowCount && account.rows[0].enabled && !account.rows[0].disconnected_at
			),
			accountId: account.rows[0]?.connected_account_id || null,
			livemode: account.rows[0]?.livemode ?? null,
			connectedAt: account.rows[0]?.connected_at || null,
			role: member.rows[0].role as string
		};
	} catch (error) {
		await client.query('ROLLBACK');
		throw error;
	} finally {
		client.release();
	}
}

export type DonationRequest = {
	tenant: string;
	campaignId?: string;
	fundraiserId?: string;
	campaignLinkCode?: string;
	requestKey: string;
	amountMinor: number;
	frequency: 'once' | 'monthly' | 'annual';
	donorName: string;
	donorEmail: string;
	termsAccepted: true;
	anonymous?: boolean;
	feeCoverage?: boolean;
	designationFundId?: string;
	address?: {
		line1: string;
		line2?: string;
		city: string;
		region: string;
		postalCode: string;
		country: string;
	};
	tribute?: {
		kind: 'honor' | 'memory';
		honoree: string;
		notifyName?: string;
		notifyEmail?: string;
	};
	utm?: { source?: string; medium?: string; campaign?: string; content?: string; term?: string };
};
export async function createDonationRequest(input: DonationRequest) {
	const { tenant, connectedAccountId } = await publicStripeAccount(input.tenant);
	const client = await getPool().connect();
	const requestKeyHash = hash(input.requestKey);
	try {
		await client.query('BEGIN');
		await client.query("SELECT set_config('app.tenant_id',$1,true)", [tenant.id]);
		// Serialize new payment requests against a platform suspension. Financial
		// webhooks deliberately do not use this gate so settled history can finish.
		const activeTenant = await client.query(
			'SELECT 1 FROM tenants WHERE id=$1 AND suspended_at IS NULL FOR SHARE',
			[tenant.id]
		);
		if (!activeTenant.rowCount)
			throw new PaymentError('Donations are unavailable for this workspace.', 404);
		let currency = tenant.currency;
		let fundraiserId: string | null = null;
		let fundId: string | null = null;
		let feeCoveredMinor = 0;
		let termsText = 'I authorize this gift to the organization.';
		let attributionSnapshot: Record<string, string | undefined> = {};
		const baseAmount = input.amountMinor;
		let chargeAmount = baseAmount;
		if (input.termsAccepted !== true)
			throw new PaymentError('Accept the donation terms to continue.', 422);
		if (input.campaignId) {
			const campaign = await client.query(
				'SELECT currency,status,fund_id,form_config,data,starts_at,ends_at,utm_source,utm_medium,utm_campaign FROM campaigns WHERE tenant_id=$1 AND id=$2',
				[tenant.id, input.campaignId]
			);
			if (
				!campaign.rowCount ||
				!['active', 'published', 'scheduled'].includes(campaign.rows[0].status) ||
				(campaign.rows[0].starts_at &&
					new Date(campaign.rows[0].starts_at).getTime() > Date.now()) ||
				(campaign.rows[0].ends_at && new Date(campaign.rows[0].ends_at).getTime() <= Date.now())
			)
				throw new PaymentError('That campaign is not accepting donations.', 404);
			if (campaign.rows[0].data?.acceptsOnlineGifts === false)
				throw new PaymentError('That campaign is not accepting online donations.', 404);
			currency = String(campaign.rows[0].currency).trim().toUpperCase();
			const config = campaign.rows[0].form_config || {};
			if (!Array.isArray(config.frequencies) || !config.frequencies.includes(input.frequency))
				throw new PaymentError('That donation frequency is not available.', 422);
			if (!String(config.terms || '').trim())
				throw new PaymentError('Donation authorization terms are not configured.', 503);
			termsText = String(config.terms).trim();
			const utm = input.utm || {};
			const clean = (value: unknown) =>
				typeof value === 'string' ? value.trim().slice(0, 80) : '';
			attributionSnapshot = {
				utmSource: clean(utm.source) || String(campaign.rows[0].utm_source || ''),
				utmMedium: clean(utm.medium) || String(campaign.rows[0].utm_medium || ''),
				utmCampaign: clean(utm.campaign) || String(campaign.rows[0].utm_campaign || ''),
				utmContent: clean(utm.content),
				utmTerm: clean(utm.term),
				campaignLinkCode: input.campaignLinkCode || undefined,
				fundraisingPageId: input.fundraiserId || undefined
			};
			if (
				baseAmount < 50 ||
				(!config.allowCustomAmount && !(config.suggestedAmounts || []).includes(baseAmount))
			)
				throw new PaymentError('Choose an available donation amount.', 422);
			if (input.anonymous && config.allowAnonymous !== true)
				throw new PaymentError('Anonymous gifts are not available for this campaign.', 422);
			if (input.tribute && config.allowTribute !== true)
				throw new PaymentError('Tribute gifts are not available for this campaign.', 422);
			if (config.askForAddress === true && !input.address)
				throw new PaymentError('Provide the requested mailing address.', 422);
			if (input.address && config.askForAddress !== true)
				throw new PaymentError('An address was not requested for this campaign.', 422);
			if (
				input.address &&
				(!/^[A-Za-z]{2}$/.test(input.address.country) ||
					!input.address.line1.trim() ||
					!input.address.city.trim() ||
					!input.address.region.trim() ||
					!input.address.postalCode.trim())
			)
				throw new PaymentError('Provide a complete mailing address.', 422);
			if (
				input.tribute &&
				(input.tribute.honoree.trim().length < 2 ||
					(input.tribute.notifyEmail && !/^\S+@\S+\.\S+$/.test(input.tribute.notifyEmail)))
			)
				throw new PaymentError('Provide valid tribute information.', 422);
			if (input.designationFundId && config.allowDesignation !== true)
				throw new PaymentError('Donor designation is not available.', 422);
			const allowedFunds = [
				...(Array.isArray(config.designationFundIds) ? config.designationFundIds : []),
				...(campaign.rows[0].fund_id ? [campaign.rows[0].fund_id] : [])
			];
			if (input.designationFundId && !allowedFunds.includes(input.designationFundId))
				throw new PaymentError('That designation is not available.', 422);
			fundId = input.designationFundId || campaign.rows[0].fund_id || null;
			if (fundId) {
				const fund = await client.query(
					'SELECT 1 FROM funds WHERE tenant_id=$1 AND id=$2 AND active=true',
					[tenant.id, fundId]
				);
				if (!fund.rowCount) throw new PaymentError('That designation is not available.', 422);
			}
			const bps = Number(config.feeCoverageBasisPoints || 0);
			const fixed = Number(config.feeCoverageFixedMinor || 0);
			if (bps < 0 || bps > 3000 || fixed < 0 || fixed > 500)
				throw new PaymentError('Campaign fee settings are invalid.', 503);
			if (input.feeCoverage && config.allowFeeCoverage !== true)
				throw new PaymentError('Fee coverage is not available.', 422);
			feeCoveredMinor = input.feeCoverage
				? Math.ceil(((baseAmount * bps) / 10000 + fixed) / (1 - bps / 10000))
				: 0;
			chargeAmount = baseAmount + feeCoveredMinor;
			if (!Number.isSafeInteger(chargeAmount) || chargeAmount > 25_000_000)
				throw new PaymentError('The donation amount is above the allowed limit.', 422);
		} else if (
			input.anonymous ||
			input.feeCoverage ||
			input.designationFundId ||
			input.address ||
			input.tribute ||
			input.utm
		) {
			throw new PaymentError('Donation options require a campaign.', 422);
		}
		if (input.campaignId) {
			if (input.fundraiserId) {
				const page = await client.query(
					"SELECT id FROM fundraising_pages WHERE tenant_id=$1 AND campaign_id=$2 AND id=$3 AND status='published'",
					[tenant.id, input.campaignId, input.fundraiserId]
				);
				if (!page.rowCount) throw new PaymentError('That fundraising page is not available.', 404);
				fundraiserId = String(page.rows[0].id);
			}
			if (input.campaignLinkCode) {
				const link = await client.query(
					'SELECT fundraiser_id FROM campaign_links WHERE tenant_id=$1 AND campaign_id=$2 AND code=$3',
					[tenant.id, input.campaignId, input.campaignLinkCode]
				);
				if (!link.rowCount) throw new PaymentError('That donation link is not available.', 404);
				if (link.rows[0].fundraiser_id) {
					if (fundraiserId && fundraiserId !== String(link.rows[0].fundraiser_id))
						throw new PaymentError('Donation link attribution does not match.', 422);
					fundraiserId = String(link.rows[0].fundraiser_id);
				}
			}
		} else if (input.fundraiserId || input.campaignLinkCode)
			throw new PaymentError('Attribution requires a campaign.', 422);
		const fingerprint = hash(
			JSON.stringify([
				input.campaignId || null,
				fundraiserId,
				input.campaignLinkCode || null,
				baseAmount,
				chargeAmount,
				currency,
				input.frequency,
				input.donorEmail.trim().toLowerCase(),
				input.donorName.trim(),
				input.anonymous === true,
				input.feeCoverage === true,
				feeCoveredMinor,
				fundId,
				input.address || null,
				input.tribute || null,
				termsText,
				attributionSnapshot
			])
		);
		const prior = await client.query(
			'SELECT * FROM donation_intents WHERE tenant_id=$1 AND request_key_hash=$2',
			[tenant.id, requestKeyHash]
		);
		if (prior.rowCount) {
			if (prior.rows[0].request_fingerprint !== fingerprint)
				throw new PaymentError(
					'This donation request key was already used with different details.',
					409
				);
			await client.query('COMMIT');
			return { tenant, connectedAccountId, currency, row: prior.rows[0], existing: true };
		}
		if (input.campaignLinkCode && input.campaignId)
			await client.query(
				'UPDATE campaign_links SET clicks=clicks+1 WHERE tenant_id=$1 AND campaign_id=$2 AND code=$3',
				[tenant.id, input.campaignId, input.campaignLinkCode]
			);
		const inserted = await client.query(
			`INSERT INTO donation_intents(tenant_id,campaign_id,fundraising_page_id,stripe_account_id,request_key_hash,request_fingerprint,amount_minor,currency,frequency,donor_name,donor_email,fund_id,anonymous,fee_covered_minor,donor_address,tribute_data,terms_text,terms_accepted_at,attribution_snapshot) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,now(),$18) RETURNING *`,
			[
				tenant.id,
				input.campaignId || null,
				fundraiserId,
				connectedAccountId,
				requestKeyHash,
				fingerprint,
				chargeAmount,
				currency,
				input.frequency,
				input.donorName.trim(),
				input.donorEmail.trim().toLowerCase(),
				fundId,
				input.anonymous === true,
				feeCoveredMinor,
				input.address ? JSON.stringify(input.address) : null,
				input.tribute ? JSON.stringify(input.tribute) : null,
				termsText,
				attributionSnapshot
			]
		);
		await client.query('COMMIT');
		return { tenant, connectedAccountId, currency, row: inserted.rows[0], existing: false };
	} catch (error) {
		await client.query('ROLLBACK');
		throw error;
	} finally {
		client.release();
	}
}
export async function saveStripeIntent(
	tenantId: string,
	intentId: string,
	data: { paymentIntentId?: string; subscriptionId?: string; customerId?: string; status: string }
) {
	const client = await getPool().connect();
	try {
		await client.query('BEGIN');
		await client.query("SELECT set_config('app.tenant_id',$1,true)", [tenantId]);
		const result = await client.query(
			`UPDATE donation_intents SET stripe_payment_intent_id=COALESCE($3,stripe_payment_intent_id),stripe_subscription_id=COALESCE($4,stripe_subscription_id),stripe_customer_id=COALESCE($5,stripe_customer_id),status=$6,updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING id`,
			[
				tenantId,
				intentId,
				data.paymentIntentId || null,
				data.subscriptionId || null,
				data.customerId || null,
				data.status
			]
		);
		if (!result.rowCount) throw new PaymentError('Donation request could not be saved.', 503);
		await client.query('COMMIT');
	} catch (error) {
		await client.query('ROLLBACK');
		throw error;
	} finally {
		client.release();
	}
}
export async function failStripeIntent(tenantId: string, intentId: string) {
	const client = await getPool().connect();
	try {
		await client.query('BEGIN');
		await client.query("SELECT set_config('app.tenant_id',$1,true)", [tenantId]);
		await client.query(
			"UPDATE donation_intents SET status='failed',updated_at=now() WHERE tenant_id=$1 AND id=$2 AND status='creating'",
			[tenantId, intentId]
		);
		await client.query('COMMIT');
	} catch (error) {
		await client.query('ROLLBACK');
		throw error;
	} finally {
		client.release();
	}
}

function checkoutTokenSecret() {
	const secret = env.SESSION_SECRET || process.env.SESSION_SECRET;
	if (!secret) throw new PaymentError('Secure donation status tokens are not configured.', 503);
	return secret;
}
export function makeCheckoutToken(
	tenantId: string,
	intentId: string,
	expiresAt = Date.now() + 24 * 60 * 60 * 1000
) {
	const payload = Buffer.from(JSON.stringify({ tenantId, intentId, expiresAt })).toString(
		'base64url'
	);
	return `${payload}.${createHmac('sha256', checkoutTokenSecret()).update(payload).digest('base64url')}`;
}
function verifyCheckoutToken(token: string) {
	const [payload, signature, extra] = token.split('.');
	if (!payload || !signature || extra)
		throw new PaymentError('Donation status token is invalid.', 400);
	const expected = createHmac('sha256', checkoutTokenSecret()).update(payload).digest();
	const actual = Buffer.from(signature, 'base64url');
	if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
		throw new PaymentError('Donation status token is invalid.', 400);
	let claims: { tenantId: string; intentId: string; expiresAt: number };
	try {
		claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
	} catch {
		throw new PaymentError('Donation status token is invalid.', 400);
	}
	if (
		!/^[0-9a-f-]{36}$/i.test(claims.tenantId) ||
		!/^[0-9a-f-]{36}$/i.test(claims.intentId) ||
		!Number.isSafeInteger(claims.expiresAt)
	)
		throw new PaymentError('Donation status token is invalid.', 400);
	if (claims.expiresAt < Date.now())
		throw new PaymentError('Donation status token has expired.', 410);
	return claims;
}
export async function readDonationStatus(token: string) {
	const claims = verifyCheckoutToken(token);
	const client = await getPool().connect();
	try {
		await client.query('BEGIN');
		await client.query("SELECT set_config('app.tenant_id',$1,true)", [claims.tenantId]);
		const result = await client.query(
			'SELECT status,updated_at FROM donation_intents WHERE tenant_id=$1 AND id=$2',
			[claims.tenantId, claims.intentId]
		);
		await client.query('COMMIT');
		if (!result.rowCount) throw new PaymentError('Donation status was not found.', 404);
		return {
			status: result.rows[0].status as string,
			updatedAt: result.rows[0].updated_at as Date
		};
	} catch (error) {
		await client.query('ROLLBACK');
		throw error;
	} finally {
		client.release();
	}
}

async function tenantForStripeAccount(accountId: string) {
	const tenants = await getPool().query('SELECT id FROM tenants');
	const client = await getPool().connect();
	try {
		await client.query('BEGIN');
		for (const tenant of tenants.rows) {
			await client.query("SELECT set_config('app.tenant_id',$1,true)", [tenant.id]);
			const found = await client.query(
				'SELECT tenant_id,livemode FROM stripe_accounts WHERE connected_account_id=$1',
				[accountId]
			);
			if (found.rowCount) {
				await client.query('COMMIT');
				return { tenantId: tenant.id as string, livemode: Boolean(found.rows[0].livemode) };
			}
		}
		await client.query('ROLLBACK');
		return null;
	} catch (error) {
		await client.query('ROLLBACK');
		throw error;
	} finally {
		client.release();
	}
}

export function stripeGiftExternalEventId(type: string, object: Record<string, any>) {
	if (type === 'payment_intent.succeeded' && typeof object.id === 'string')
		return `stripe:payment_intent:${object.id}`;
	if (type === 'invoice.paid' && typeof object.id === 'string')
		return `stripe:invoice:${object.id}`;
	if (
		(type === 'refund.created' || type === 'refund.updated') &&
		object.status === 'succeeded' &&
		typeof object.id === 'string'
	)
		return `stripe:refund:${object.id}`;
	if (type === 'charge.dispute.created' && typeof object.id === 'string')
		return `stripe:dispute:${object.id}:created`;
	if (type === 'charge.dispute.closed' && object.status === 'won' && typeof object.id === 'string')
		return `stripe:dispute:${object.id}:won`;
	return null;
}
async function ensureContact(
	client: import('pg').PoolClient,
	tenantId: string,
	email: string,
	name: string
) {
	const existing = await client.query(
		'SELECT id FROM contacts WHERE tenant_id=$1 AND lower(email)=lower($2) LIMIT 1',
		[tenantId, email]
	);
	if (existing.rowCount) return existing.rows[0].id as string;
	const id = crypto.randomUUID();
	const inserted = await client.query(
		"INSERT INTO contacts(tenant_id,id,name,email,stage,tags,data) VALUES($1,$2,$3,$4,'new',ARRAY['donor'],'{}') ON CONFLICT DO NOTHING RETURNING id",
		[tenantId, id, name, email]
	);
	if (inserted.rowCount) return id;
	const raced = await client.query(
		'SELECT id FROM contacts WHERE tenant_id=$1 AND lower(email)=lower($2) LIMIT 1',
		[tenantId, email]
	);
	if (raced.rowCount) return raced.rows[0].id as string;
	throw new Error('Donor contact could not be recorded.');
}
async function findPaidGift(
	client: import('pg').PoolClient,
	tenantId: string,
	accountId: string,
	paymentIntentId: string
) {
	return client.query(
		`SELECT di.*,g.id AS gift_id FROM donation_intents di JOIN gifts g ON g.tenant_id=di.tenant_id
    WHERE di.tenant_id=$1 AND di.stripe_account_id=$2 AND (
      (di.stripe_payment_intent_id=$3 AND g.external_event_id=$4) OR
      EXISTS(SELECT 1 FROM stripe_invoice_payments sip WHERE sip.tenant_id=di.tenant_id AND sip.donation_intent_id=di.id
        AND sip.stripe_account_id=$2 AND sip.stripe_payment_intent_id=$3 AND g.external_event_id='stripe:invoice:'||sip.stripe_invoice_id)
    ) LIMIT 1`,
		[tenantId, accountId, paymentIntentId, `stripe:payment_intent:${paymentIntentId}`]
	);
}
async function insertGift(
	client: import('pg').PoolClient,
	tenantId: string,
	data: {
		intent: any;
		externalEventId: string;
		status?: string;
		amountMinor?: number;
		eventType: string;
		direction?: string;
	}
) {
	const intent = data.intent;
	const amountMinor = data.amountMinor ?? Number(intent.amount_minor);
	if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0)
		throw new PaymentError('The payment provider returned an unsupported amount.', 422);
	const contactId =
		intent.contact_id ||
		(await ensureContact(client, tenantId, intent.donor_email, intent.donor_name));
	const giftId = crypto.randomUUID();
	const result = await client.query(
		`INSERT INTO gifts(tenant_id,id,contact_id,campaign_id,fundraising_page_id,fund_id,amount_minor,currency,kind,status,occurred_at,external_event_id,correction_of,data)
	    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now(),$11,$12,$13) ON CONFLICT(tenant_id,external_event_id) WHERE external_event_id IS NOT NULL DO NOTHING RETURNING id`,
		[
			tenantId,
			giftId,
			contactId,
			intent.campaign_id,
			intent.fundraising_page_id || null,
			intent.fund_id || null,
			amountMinor,
			String(intent.currency).trim().toUpperCase(),
			data.direction ? 'correction' : intent.frequency === 'once' ? 'one_time' : 'recurring',
			data.status || 'recorded',
			data.externalEventId,
			data.direction ? intent.gift_id : null,
			{
				source: 'stripe',
				frequency: intent.frequency,
				fundraisingPageId: intent.fundraising_page_id || undefined,
				eventType: data.eventType,
				direction: data.direction || 'credit',
				correctionOf: data.direction ? intent.gift_id : undefined,
				attribution: intent.attribution_snapshot || {}
			}
		]
	);
	if (result.rowCount) {
		if (!intent.contact_id)
			await client.query('UPDATE donation_intents SET contact_id=$2 WHERE tenant_id=$1 AND id=$3', [
				tenantId,
				contactId,
				intent.id
			]);
		if (!data.direction) {
			const fundName = intent.fund_id
				? await client.query('SELECT name FROM funds WHERE tenant_id=$1 AND id=$2', [
						tenantId,
						intent.fund_id
					])
				: null;
			await client.query(
				`INSERT INTO donation_financial_details(tenant_id,gift_id,fee_minor,settlement_minor,method,designation,anonymous,donor_fee_minor)
				 VALUES($1,$2,0,NULL,'online',$3,$4,$5) ON CONFLICT(tenant_id,gift_id) DO NOTHING`,
				[
					tenantId,
					giftId,
					fundName?.rows[0]?.name || null,
					Boolean(intent.anonymous),
					Number(intent.fee_covered_minor || 0)
				]
			);
			if (intent.tribute_data) {
				const tribute =
					typeof intent.tribute_data === 'string'
						? JSON.parse(intent.tribute_data)
						: intent.tribute_data;
				await client.query(
					'INSERT INTO tributes(tenant_id,gift_id,honoree,kind,notify_name,notify_email) VALUES($1,$2,$3,$4,$5,$6)',
					[
						tenantId,
						giftId,
						tribute.honoree,
						tribute.kind,
						tribute.notifyName || null,
						tribute.notifyEmail || null
					]
				);
			}
			if (intent.donor_address) {
				const address =
					typeof intent.donor_address === 'string'
						? JSON.parse(intent.donor_address)
						: intent.donor_address;
				await client.query(
					'UPDATE addresses SET preferred=false,updated_at=now() WHERE tenant_id=$1 AND contact_id=$2 AND preferred=true',
					[tenantId, contactId]
				);
				await client.query(
					"INSERT INTO addresses(tenant_id,contact_id,label,line1,line2,city,region,postal_code,country,preferred) VALUES($1,$2,'home',$3,$4,$5,$6,$7,$8,true)",
					[
						tenantId,
						contactId,
						address.line1,
						address.line2 || '',
						address.city,
						address.region,
						address.postalCode,
						address.country.toUpperCase()
					]
				);
			}
		}
		await client.query(
			'INSERT INTO audit_log(tenant_id,action,resource,record_id,details) VALUES($1,$2,$3,$4,$5)',
			[
				tenantId,
				'gift.recorded',
				'gifts',
				giftId,
				{ provider: 'stripe', eventType: data.eventType }
			]
		);
		await client.query(
			'INSERT INTO outbox_events(tenant_id,event_type,payload,idempotency_key) VALUES($1,$2,$3,$4) ON CONFLICT(idempotency_key) DO NOTHING',
			[
				tenantId,
				'gift.recorded',
				{ resource: 'gifts', recordId: giftId },
				`gift.receipt:${tenantId}:${giftId}`
			]
		);
	}
	return result.rowCount ? giftId : null;
}
function objectValue(value: unknown) {
	return typeof value === 'object' && value !== null ? (value as Record<string, any>) : {};
}
function subscriptionId(invoice: Record<string, any>) {
	const direct = invoice.subscription;
	if (typeof direct === 'string') return direct;
	const nested = invoice.parent?.subscription_details?.subscription;
	return typeof nested === 'string'
		? nested
		: typeof nested?.id === 'string'
			? nested.id
			: typeof direct?.id === 'string'
				? direct.id
				: null;
}

async function recordRecurringStatus(
	client: import('pg').PoolClient,
	tenantId: string,
	accountId: string,
	event: Stripe.Event,
	intent: any,
	newStatus: string,
	periodStart?: number | null,
	periodEnd?: number | null
) {
	await client.query(
		`INSERT INTO recurring_status_events(tenant_id,donation_intent_id,stripe_event_id,stripe_account_id,event_type,previous_status,new_status,effective_at,period_start,period_end)
		 VALUES($1,$2,$3,$4,$5,$6,$7,to_timestamp($8),CASE WHEN $9::bigint IS NULL THEN NULL ELSE to_timestamp($9) END,CASE WHEN $10::bigint IS NULL THEN NULL ELSE to_timestamp($10) END)
		 ON CONFLICT(tenant_id,stripe_event_id,donation_intent_id) DO NOTHING`,
		[
			tenantId,
			intent.id,
			event.id,
			accountId,
			event.type,
			intent.status || 'incomplete',
			newStatus,
			event.created,
			periodStart ?? null,
			periodEnd ?? null
		]
	);
}

async function reduceEvent(
	client: import('pg').PoolClient,
	tenantId: string,
	event: Stripe.Event,
	accountId: string
) {
	const object = objectValue(event.data.object);
	if (event.type.startsWith('payment_intent.')) {
		const registrationId = object.metadata?.event_registration_id;
		if (typeof registrationId === 'string') {
			const found = await client.query(
				'SELECT id,amount_minor,currency,status,stripe_account_id,stripe_payment_intent_id FROM event_registrations WHERE tenant_id=$1 AND id=$2 FOR UPDATE',
				[tenantId, registrationId]
			);
			if (!found.rowCount) return false;
			const registration = found.rows[0];
			if (
				registration.stripe_account_id !== accountId ||
				registration.stripe_payment_intent_id !== object.id ||
				Number(registration.amount_minor) !== Number(object.amount) ||
				String(registration.currency).trim().toLowerCase() !== String(object.currency).toLowerCase()
			)
				throw new PaymentError('Ticket payment does not match its registration.', 422);
			if (event.type === 'payment_intent.succeeded') {
				await client.query(
					"UPDATE event_registrations SET status='registered' WHERE tenant_id=$1 AND id=$2 AND status='pending_payment'",
					[tenantId, registrationId]
				);
				await client.query(
					"INSERT INTO audit_log(tenant_id,action,resource,record_id,details) VALUES($1,'event.registration.paid','event_registrations',$2,$3) ON CONFLICT DO NOTHING",
					[tenantId, registrationId, { provider: 'stripe', eventId: event.id }]
				);
			} else if (
				event.type === 'payment_intent.payment_failed' ||
				event.type === 'payment_intent.canceled'
			) {
				await client.query(
					"UPDATE event_registrations SET status='payment_failed' WHERE tenant_id=$1 AND id=$2 AND status='pending_payment'",
					[tenantId, registrationId]
				);
			}
			return true;
		}
		const found = await client.query(
			'SELECT * FROM donation_intents WHERE tenant_id=$1 AND stripe_account_id=$2 AND stripe_payment_intent_id=$3 FOR UPDATE',
			[tenantId, accountId, object.id]
		);
		if (!found.rowCount) return event.type === 'payment_intent.succeeded' ? false : true;
		const intent = found.rows[0];
		const status =
			event.type === 'payment_intent.succeeded'
				? 'succeeded'
				: event.type === 'payment_intent.payment_failed'
					? 'failed'
					: event.type === 'payment_intent.canceled'
						? 'canceled'
						: 'processing';
		await client.query(
			"UPDATE donation_intents SET status=$2,succeeded_at=CASE WHEN $2='succeeded' THEN COALESCE(succeeded_at,now()) ELSE succeeded_at END,updated_at=now() WHERE tenant_id=$1 AND id=$3",
			[tenantId, status, intent.id]
		);
		if (event.type === 'payment_intent.succeeded' && intent.frequency === 'once')
			await insertGift(client, tenantId, {
				intent,
				externalEventId: stripeGiftExternalEventId(event.type, object)!,
				eventType: event.type
			});
		return true;
	}
	if (event.type === 'invoice.paid' || event.type === 'invoice.payment_failed') {
		const subId = subscriptionId(object);
		if (!subId) return true;
		const found = await client.query(
			'SELECT * FROM donation_intents WHERE tenant_id=$1 AND stripe_account_id=$2 AND stripe_subscription_id=$3 FOR UPDATE',
			[tenantId, accountId, subId]
		);
		if (!found.rowCount) return false;
		const intent = found.rows[0];
		if (event.type === 'invoice.paid') {
			const linePeriod = object.lines?.data?.[0]?.period || {};
			const periodStart = object.period_start ?? linePeriod.start ?? null;
			const periodEnd = object.period_end ?? linePeriod.end ?? null;
			await recordRecurringStatus(
				client,
				tenantId,
				accountId,
				event,
				intent,
				'active',
				periodStart,
				periodEnd
			);
			await client.query(
				"UPDATE donation_intents SET status='active',stripe_invoice_id=$2,succeeded_at=COALESCE(succeeded_at,now()),updated_at=now() WHERE tenant_id=$1 AND id=$3",
				[tenantId, object.id, intent.id]
			);
			const invoicePaymentIntent =
				typeof object.payment_intent === 'string'
					? object.payment_intent
					: object.payment_intent?.id;
			if (invoicePaymentIntent)
				await client.query(
					`INSERT INTO stripe_invoice_payments(tenant_id,stripe_account_id,stripe_invoice_id,stripe_payment_intent_id,donation_intent_id)
        VALUES($1,$2,$3,$4,$5) ON CONFLICT(tenant_id,stripe_invoice_id) DO UPDATE SET stripe_payment_intent_id=EXCLUDED.stripe_payment_intent_id,donation_intent_id=EXCLUDED.donation_intent_id`,
					[tenantId, accountId, object.id, invoicePaymentIntent, intent.id]
				);
			await insertGift(client, tenantId, {
				intent,
				externalEventId: stripeGiftExternalEventId(event.type, object)!,
				eventType: event.type
			});
		} else {
			await recordRecurringStatus(
				client,
				tenantId,
				accountId,
				event,
				intent,
				'past_due',
				object.period_start,
				object.period_end
			);
			await client.query(
				"UPDATE donation_intents SET status='past_due',updated_at=now() WHERE tenant_id=$1 AND id=$2",
				[tenantId, intent.id]
			);
		}
		return true;
	}
	if (
		event.type === 'customer.subscription.updated' ||
		event.type === 'customer.subscription.deleted'
	) {
		const status =
			event.type === 'customer.subscription.deleted'
				? 'ended'
				: (
						{
							active: 'active',
							past_due: 'past_due',
							incomplete: 'incomplete',
							canceled: 'ended'
						} as Record<string, string>
					)[object.status] || 'past_due';
		const found = await client.query(
			'SELECT * FROM donation_intents WHERE tenant_id=$1 AND stripe_account_id=$2 AND stripe_subscription_id=$3 FOR UPDATE',
			[tenantId, accountId, object.id]
		);
		if (!found.rowCount) return true;
		await recordRecurringStatus(
			client,
			tenantId,
			accountId,
			event,
			found.rows[0],
			status,
			object.current_period_start,
			object.current_period_end
		);
		await client.query(
			'UPDATE donation_intents SET status=$3,updated_at=now() WHERE tenant_id=$1 AND stripe_account_id=$2 AND stripe_subscription_id=$4',
			[tenantId, accountId, status, object.id]
		);
		return true;
	}
	if (event.type === 'refund.created' || event.type === 'refund.updated') {
		if (object.status !== 'succeeded') return true;
		const paymentIntentId =
			typeof object.payment_intent === 'string' ? object.payment_intent : object.payment_intent?.id;
		if (!paymentIntentId) return true;
		const found = await findPaidGift(client, tenantId, accountId, paymentIntentId);
		if (!found.rowCount) return false;
		await insertGift(client, tenantId, {
			intent: found.rows[0],
			externalEventId: stripeGiftExternalEventId(event.type, object)!,
			amountMinor: Number(object.amount),
			status: 'refunded',
			eventType: event.type,
			direction: 'debit'
		});
		return true;
	}
	if (event.type === 'charge.dispute.created' || event.type === 'charge.dispute.closed') {
		const paymentIntentId =
			typeof object.payment_intent === 'string' ? object.payment_intent : object.payment_intent?.id;
		if (!paymentIntentId) return true;
		const found = await findPaidGift(client, tenantId, accountId, paymentIntentId);
		if (!found.rowCount) return false;
		const closedWon = event.type === 'charge.dispute.closed' && object.status === 'won';
		if (event.type === 'charge.dispute.created' || closedWon)
			await insertGift(client, tenantId, {
				intent: found.rows[0],
				externalEventId: stripeGiftExternalEventId(event.type, object)!,
				amountMinor: Number(object.amount),
				status: closedWon ? 'recorded' : 'disputed',
				eventType: event.type,
				direction: closedWon ? 'reinstatement' : 'debit'
			});
		return true;
	}
	return true;
}

export async function processStripeEvent(event: Stripe.Event, rawBody: string) {
	const accountId = event.account;
	if (!accountId) throw new PaymentError('Only connected-account events are accepted.', 400);
	const connected = await tenantForStripeAccount(accountId);
	if (!connected) throw new PaymentError('Stripe account is not connected to a workspace.', 404);
	const tenantId = connected.tenantId;
	if (connected.livemode !== event.livemode)
		throw new PaymentError('Stripe event mode does not match the connected account.', 400);
	const client = await getPool().connect();
	const payloadHash = hash(rawBody);
	try {
		await client.query('BEGIN');
		await client.query("SELECT set_config('app.tenant_id',$1,true)", [tenantId]);
		const inserted = await client.query(
			'INSERT INTO stripe_event_ingress(event_id,tenant_id,stripe_account_id,event_type,payload_hash) VALUES($1,$2,$3,$4,$5) ON CONFLICT(event_id) DO NOTHING RETURNING event_id',
			[event.id, tenantId, accountId, event.type, payloadHash]
		);
		if (!inserted.rowCount) {
			const existing = await client.query(
				'SELECT tenant_id,processed_at FROM stripe_event_ingress WHERE event_id=$1 FOR UPDATE',
				[event.id]
			);
			if (!existing.rowCount || existing.rows[0].tenant_id !== tenantId)
				throw new PaymentError(
					'Stripe event ID conflicts with a different connected workspace.',
					409
				);
			const hashRow = await client.query(
				'SELECT payload_hash FROM stripe_event_ingress WHERE event_id=$1',
				[event.id]
			);
			if (hashRow.rows[0].payload_hash !== payloadHash)
				throw new PaymentError('Stripe event ID was replayed with different contents.', 409);
			if (existing.rows[0].processed_at) {
				await client.query('COMMIT');
				return { duplicate: true };
			}
			await client.query('UPDATE stripe_event_ingress SET attempts=attempts+1 WHERE event_id=$1', [
				event.id
			]);
		}
		const handled = await reduceEvent(client, tenantId, event, accountId);
		if (!handled)
			throw new Error('Stripe event references a donation request that is not available yet.');
		await client.query(
			'UPDATE stripe_event_ingress SET processed_at=now(),last_error=null WHERE event_id=$1',
			[event.id]
		);
		await client.query('COMMIT');
		return { duplicate: false };
	} catch (error) {
		await client.query('ROLLBACK');
		try {
			await client.query('BEGIN');
			await client.query("SELECT set_config('app.tenant_id',$1,true)", [tenantId]);
			await client.query(
				'UPDATE stripe_event_ingress SET attempts=attempts+1,last_error=$2 WHERE event_id=$1',
				[event.id, 'Event processing failed; Stripe will retry.']
			);
			await client.query('COMMIT');
		} catch {
			await client.query('ROLLBACK').catch(() => undefined);
		}
		throw error;
	} finally {
		client.release();
	}
}

export { stripeClient, platformKey };
