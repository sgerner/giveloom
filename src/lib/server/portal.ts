import {
	createCipheriv,
	createDecipheriv,
	createHash,
	createHmac,
	randomBytes,
	randomUUID,
	timingSafeEqual
} from 'node:crypto';
import { env } from '$env/dynamic/private';
import type { Pool, PoolClient } from 'pg';
import { stripeClient } from './payments';
import { getPool } from './database';
import { safeMinorUnits } from './domain';

const LINK_TTL_MS = 15 * 60 * 1000;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const secret = () =>
	env.SESSION_SECRET || (process.env.NODE_ENV === 'production' ? '' : 'local-demo-only-change-me');
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const keyFor = (purpose: string) =>
	createHash('sha256').update(`giveloom:${purpose}:v1:${secret()}`).digest();
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class PortalError extends Error {
	constructor(
		message: string,
		readonly status: number
	) {
		super(message);
		this.name = 'PortalError';
	}
}

function sealToken(token: string, context: string) {
	if (!secret()) throw new PortalError('Portal authentication is not configured.', 503);
	const iv = randomBytes(12);
	const cipher = createCipheriv('aes-256-gcm', keyFor('portal-link-encryption'), iv);
	cipher.setAAD(Buffer.from(context));
	const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
	return [
		iv.toString('base64url'),
		cipher.getAuthTag().toString('base64url'),
		ciphertext.toString('base64url')
	].join('.');
}

function openToken(envelope: string, context: string) {
	const [ivText, tagText, cipherText] = envelope.split('.');
	if (!ivText || !tagText || !cipherText || !secret())
		throw new Error('Portal link envelope is invalid');
	const decipher = createDecipheriv(
		'aes-256-gcm',
		keyFor('portal-link-encryption'),
		Buffer.from(ivText, 'base64url')
	);
	decipher.setAAD(Buffer.from(context));
	decipher.setAuthTag(Buffer.from(tagText, 'base64url'));
	return Buffer.concat([
		decipher.update(Buffer.from(cipherText, 'base64url')),
		decipher.final()
	]).toString('utf8');
}

function signToken(kind: 'link' | 'session', claims: Record<string, unknown>) {
	if (!secret()) throw new PortalError('Portal authentication is not configured.', 503);
	const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
	const signature = createHmac('sha256', keyFor(`portal-${kind}-signing`))
		.update(payload)
		.digest('base64url');
	return `${payload}.${signature}`;
}

function readSignedToken<T extends Record<string, unknown>>(
	token: string,
	kind: 'link' | 'session'
): T | null {
	const [payload, signature, extra] = token.split('.');
	if (!payload || !signature || extra || !secret()) return null;
	const expected = createHmac('sha256', keyFor(`portal-${kind}-signing`))
		.update(payload)
		.digest();
	const actual = Buffer.from(signature, 'base64url');
	if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
	try {
		return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as T;
	} catch {
		return null;
	}
}

async function withTenant<T>(
	tenantId: string,
	callback: (client: PoolClient) => Promise<T>,
	pool: Pool = getPool()
): Promise<T> {
	const client = await pool.connect();
	try {
		await client.query('BEGIN');
		await client.query("SELECT set_config('app.tenant_id',$1,true)", [tenantId]);
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

export async function requestPortalLink(
	tenantSlug: string,
	emailInput: string,
	pool: Pool = getPool()
) {
	const email = emailInput.trim().normalize('NFKC').toLowerCase();
	if (!emailPattern.test(email)) return false;
	const tenant = await pool.query<{ id: string; slug: string; legal_name: string }>(
		'SELECT id,slug,legal_name FROM tenants WHERE slug=$1 AND suspended_at IS NULL',
		[tenantSlug]
	);
	if (!tenant.rowCount || !secret()) return false;
	const tenantId = tenant.rows[0].id;
	const linkId = randomUUID();
	const rawToken = signToken('link', {
		tenantId,
		nonce: randomBytes(32).toString('base64url'),
		linkId
	});
	const envelope = sealToken(rawToken, `${tenantId}:${linkId}`);
	return withTenant(
		tenantId,
		async (client) => {
			const activeTenant = await client.query(
				'SELECT id FROM tenants WHERE id=$1 AND suspended_at IS NULL FOR SHARE',
				[tenantId]
			);
			if (!activeTenant.rowCount) return false;
			const contact = await client.query<{ id: string; email: string }>(
				'SELECT id,email FROM contacts WHERE tenant_id=$1 AND lower(email)=lower($2) AND archived_at IS NULL AND merged_into IS NULL LIMIT 1',
				[tenantId, email]
			);
			if (!contact.rowCount) return false;
			const contactId = contact.rows[0].id;
			await client.query(
				`UPDATE portal_magic_links SET delivery_status='cancelled',token_ciphertext=''
			WHERE tenant_id=$1 AND contact_id=$2 AND consumed_at IS NULL AND expires_at>now() AND delivery_status='queued'`,
				[tenantId, contactId]
			);
			await client.query(
				`INSERT INTO portal_magic_links(id,tenant_id,contact_id,token_hash,token_ciphertext,expires_at)
			VALUES($1,$2,$3,$4,$5,now()+interval '15 minutes')`,
				[linkId, tenantId, contactId, sha256(rawToken), envelope]
			);
			await client.query(
				`INSERT INTO outbox_events(tenant_id,event_type,payload,idempotency_key)
			VALUES($1,'portal.magic_link',$2,$3) ON CONFLICT(idempotency_key) DO NOTHING`,
				[tenantId, { magicLinkId: linkId }, `portal.magic_link:${tenantId}:${linkId}`]
			);
			return true;
		},
		pool
	);
}

export type PortalSession = {
	id: string;
	tenantId: string;
	contactId: string;
	tokenHash: string;
	expiresAt: number;
};

export async function consumePortalLink(
	token: string,
	pool: Pool = getPool()
): Promise<{ cookie: string; session: PortalSession }> {
	if (token.length > 2048) throw new PortalError('This sign-in link is invalid or expired.', 401);
	const claims = readSignedToken<{ tenantId: string; linkId: string; nonce: string }>(
		token,
		'link'
	);
	if (
		!claims ||
		!/^[0-9a-f-]{36}$/i.test(claims.tenantId) ||
		!/^[0-9a-f-]{36}$/i.test(claims.linkId) ||
		!claims.nonce
	)
		throw new PortalError('This sign-in link is invalid or expired.', 401);
	const session = await withTenant(
		claims.tenantId,
		async (client) => {
			const activeTenant = await client.query(
				'SELECT id FROM tenants WHERE id=$1 AND suspended_at IS NULL FOR SHARE',
				[claims.tenantId]
			);
			if (!activeTenant.rowCount)
				throw new PortalError('This sign-in link is invalid or expired.', 401);
			const link = await client.query<{ contact_id: string }>(
				`UPDATE portal_magic_links l SET consumed_at=now(),token_ciphertext=''
			FROM tenants t WHERE t.id=l.tenant_id AND t.suspended_at IS NULL
			AND l.tenant_id=$1 AND l.id=$2 AND l.token_hash=$3 AND l.consumed_at IS NULL AND l.expires_at>now() AND l.sent_at IS NOT NULL
			RETURNING contact_id`,
				[claims.tenantId, claims.linkId, sha256(token)]
			);
			if (!link.rowCount) throw new PortalError('This sign-in link is invalid or expired.', 401);
			const contact = await client.query(
				'SELECT 1 FROM contacts WHERE tenant_id=$1 AND id=$2 AND archived_at IS NULL AND merged_into IS NULL',
				[claims.tenantId, link.rows[0].contact_id]
			);
			if (!contact.rowCount) throw new PortalError('This sign-in link is invalid or expired.', 401);
			const id = randomUUID();
			const expiresAt = Date.now() + SESSION_TTL_MS;
			const cookie = signToken('session', {
				id,
				tenantId: claims.tenantId,
				contactId: link.rows[0].contact_id,
				exp: expiresAt,
				nonce: randomBytes(12).toString('base64url')
			});
			const tokenHash = sha256(cookie);
			await client.query(
				'INSERT INTO portal_sessions(id,tenant_id,contact_id,token_hash,expires_at) VALUES($1,$2,$3,$4,to_timestamp($5/1000.0))',
				[id, claims.tenantId, link.rows[0].contact_id, tokenHash, expiresAt]
			);
			return {
				cookie,
				session: {
					id,
					tenantId: claims.tenantId,
					contactId: link.rows[0].contact_id,
					tokenHash,
					expiresAt
				}
			};
		},
		pool
	);
	return session;
}

function decodePortalSession(cookie: string) {
	const claims = readSignedToken<{
		id: string;
		tenantId: string;
		contactId: string;
		exp: number;
		nonce: string;
	}>(cookie, 'session');
	if (
		!claims ||
		!/^[0-9a-f-]{36}$/i.test(claims.id) ||
		!/^[0-9a-f-]{36}$/i.test(claims.tenantId) ||
		!/^[0-9a-f-]{36}$/i.test(claims.contactId) ||
		!Number.isFinite(claims.exp) ||
		claims.exp <= Date.now() ||
		!claims.nonce
	)
		return null;
	return { ...claims, tokenHash: sha256(cookie) };
}

export async function getPortalOverview(cookie: string | undefined, pool: Pool = getPool()) {
	if (!cookie) return null;
	const claims = decodePortalSession(cookie);
	if (!claims) return null;
	return withTenant(
		claims.tenantId,
		async (client) => {
			const session = await client.query(
				`UPDATE portal_sessions s SET last_seen_at=now()
			FROM contacts c WHERE s.tenant_id=$1 AND s.id=$2 AND s.contact_id=$3 AND s.token_hash=$4 AND s.revoked_at IS NULL AND s.expires_at>now()
			AND c.tenant_id=s.tenant_id AND c.id=s.contact_id AND c.archived_at IS NULL AND c.merged_into IS NULL
			RETURNING c.id,c.name,c.email`,
				[claims.tenantId, claims.id, claims.contactId, claims.tokenHash]
			);
			if (!session.rowCount) return null;
			const [tenant, gifts, preference, introductions, addresses, tickets] = await Promise.all([
				client.query(
					'SELECT slug,legal_name,currency,suspended_at IS NOT NULL AS "suspended" FROM tenants WHERE id=$1',
					[claims.tenantId]
				),
				client.query(
					`SELECT g.id,g.amount_minor AS "amountMinor",g.currency,g.kind,g.status,g.occurred_at AS "occurredAt",
				g.correction_of AS "correctionOf",ca.name AS "campaignName"
				FROM gifts g LEFT JOIN campaigns ca ON ca.tenant_id=g.tenant_id AND ca.id=g.campaign_id
				WHERE g.tenant_id=$1 AND g.contact_id=$2 ORDER BY g.occurred_at DESC LIMIT 500`,
					[claims.tenantId, claims.contactId]
				),
				client.query(
					`SELECT receipt_emails AS "receiptEmails",newsletter_opt_in AS "newsletterOptIn"
				FROM portal_preferences WHERE tenant_id=$1 AND contact_id=$2`,
					[claims.tenantId, claims.contactId]
				),
				client.query(
					`SELECT w.id,w.data->>'title' AS title,w.data->>'stage' AS stage,p.name AS "prospectName"
					 FROM workspace_records w LEFT JOIN prospects p ON p.tenant_id=w.tenant_id AND p.id=nullif(w.data->>'prospectId','')::uuid
					 WHERE w.tenant_id=$1 AND w.resource='introductions' AND w.data->>'contactId'=$2 AND w.data->>'stage'='donor_asked'
					 ORDER BY w.created_at`,
					[claims.tenantId, claims.contactId]
				),
				client.query(
					'SELECT line1,line2,city,region,postal_code AS "postalCode",country FROM addresses WHERE tenant_id=$1 AND contact_id=$2 AND preferred=true ORDER BY updated_at DESC LIMIT 1',
					[claims.tenantId, claims.contactId]
				),
				client.query(
					`SELECT r.id,r.full_name AS "fullName",r.quantity,r.status,r.amount_minor AS "amountMinor",r.currency,r.registered_at AS "registeredAt",e.name AS "eventName",e.starts_at AS "startsAt",tt.name AS "ticketName" FROM event_registrations r JOIN events e ON e.tenant_id=r.tenant_id AND e.id=r.event_id JOIN event_ticket_types tt ON tt.tenant_id=r.tenant_id AND tt.id=r.ticket_type_id WHERE r.tenant_id=$1 AND r.contact_id=$2 ORDER BY e.starts_at DESC LIMIT 100`,
					[claims.tenantId, claims.contactId]
				)
			]);
			return {
				contact: {
					id: session.rows[0].id,
					name: session.rows[0].name,
					email: session.rows[0].email
				},
				organization: tenant.rows[0]?.legal_name || 'Organization',
				tenantSlug: tenant.rows[0]?.slug || '',
				gifts: gifts.rows.map((gift) => ({
					...gift,
					amountMinor: safeMinorUnits(gift.amountMinor, 'Gift amount')
				})),
				preferences: preference.rows[0] || { receiptEmails: true, newsletterOptIn: false },
				tenantSuspended: Boolean(tenant.rows[0]?.suspended),
				introductions: introductions.rows,
				address: addresses.rows[0] || null,
				tickets: tickets.rows.map((ticket) => ({
					...ticket,
					amountMinor: safeMinorUnits(ticket.amountMinor, 'Ticket amount')
				}))
			};
		},
		pool
	);
}

export async function respondToPortalIntroduction(
	cookie: string | undefined,
	input: { introductionId: string; answer: 'yes' | 'no' | 'unsure'; note?: string },
	pool: Pool = getPool()
) {
	const claims = cookie ? decodePortalSession(cookie) : null;
	if (!claims) throw new PortalError('Sign in to respond to this introduction request.', 401);
	if (!/^[0-9a-f-]{36}$/i.test(input.introductionId))
		throw new PortalError('Introduction request not found.', 404);
	return withTenant(
		claims.tenantId,
		async (client) => {
			const session = await client.query(
				'SELECT 1 FROM portal_sessions s JOIN contacts c ON c.tenant_id=s.tenant_id AND c.id=s.contact_id JOIN tenants t ON t.id=s.tenant_id AND t.suspended_at IS NULL WHERE s.tenant_id=$1 AND s.id=$2 AND s.contact_id=$3 AND s.token_hash=$4 AND s.revoked_at IS NULL AND s.expires_at>now() AND c.archived_at IS NULL AND c.merged_into IS NULL',
				[claims.tenantId, claims.id, claims.contactId, claims.tokenHash]
			);
			if (!session.rowCount)
				throw new PortalError('Sign in to respond to this introduction request.', 401);
			const record = await client.query(
				"SELECT data FROM workspace_records WHERE tenant_id=$1 AND resource='introductions' AND id=$2 AND data->>'contactId'=$3 FOR UPDATE",
				[claims.tenantId, input.introductionId, claims.contactId]
			);
			if (!record.rowCount || record.rows[0].data?.stage !== 'donor_asked')
				throw new PortalError(
					'This introduction request is no longer awaiting your response.',
					404
				);
			const next = input.answer === 'yes' ? 'donor_consented' : 'closed';
			const evidence = 'Donor portal response';
			const updated = {
				...record.rows[0].data,
				stage: next,
				consentAnswer: input.answer,
				consentSource: evidence,
				consentAt: new Date().toISOString(),
				consentNote: (input.note || '').slice(0, 1000)
			};
			await client.query(
				"UPDATE workspace_records SET data=$4,updated_at=now() WHERE tenant_id=$1 AND resource='introductions' AND id=$2 AND data->>'contactId'=$3",
				[claims.tenantId, input.introductionId, claims.contactId, updated]
			);
			await client.query(
				"INSERT INTO introduction_events(tenant_id,introduction_id,from_stage,to_stage,consent_status,consent_evidence,note) VALUES($1,$2,'donor_asked',$3,$4,$5,$6)",
				[claims.tenantId, input.introductionId, next, input.answer, evidence, input.note || '']
			);
			await client.query(
				'INSERT INTO audit_log(tenant_id,action,resource,record_id,details) VALUES($1,$2,$3,$4,$5)',
				[
					claims.tenantId,
					'introduction.portal_response',
					'introductions',
					input.introductionId,
					{ answer: input.answer }
				]
			);
			return { stage: next, answer: input.answer };
		},
		pool
	);
}

export async function revokePortalSession(cookie: string | undefined, pool: Pool = getPool()) {
	if (!cookie) return;
	const claims = decodePortalSession(cookie);
	if (!claims) return;
	await withTenant(
		claims.tenantId,
		async (client) => {
			await client.query(
				'UPDATE portal_sessions SET revoked_at=now() WHERE tenant_id=$1 AND id=$2 AND token_hash=$3 AND revoked_at IS NULL',
				[claims.tenantId, claims.id, claims.tokenHash]
			);
		},
		pool
	);
}

export async function updatePortalPreferences(
	cookie: string | undefined,
	input: { receiptEmails?: boolean; newsletterOptIn?: boolean },
	pool: Pool = getPool()
) {
	const claims = cookie ? decodePortalSession(cookie) : null;
	if (!claims) throw new PortalError('Sign in to manage your preferences.', 401);
	if (typeof input.receiptEmails !== 'boolean' && typeof input.newsletterOptIn !== 'boolean')
		throw new PortalError('Choose a valid preference to update.', 400);
	return withTenant(
		claims.tenantId,
		async (client) => {
			const session = await client.query(
				'SELECT 1 FROM portal_sessions s JOIN contacts c ON c.tenant_id=s.tenant_id AND c.id=s.contact_id JOIN tenants t ON t.id=s.tenant_id AND t.suspended_at IS NULL WHERE s.tenant_id=$1 AND s.id=$2 AND s.contact_id=$3 AND s.token_hash=$4 AND s.revoked_at IS NULL AND s.expires_at>now() AND c.archived_at IS NULL AND c.merged_into IS NULL',
				[claims.tenantId, claims.id, claims.contactId, claims.tokenHash]
			);
			if (!session.rowCount) throw new PortalError('Sign in to manage your preferences.', 401);
			const receipt = input.receiptEmails;
			const newsletter = input.newsletterOptIn;
			const result = await client.query(
				`INSERT INTO portal_preferences(tenant_id,contact_id,receipt_emails,newsletter_opt_in)
			VALUES($1,$2,COALESCE($3,true),COALESCE($4,false)) ON CONFLICT(tenant_id,contact_id) DO UPDATE SET
			receipt_emails=COALESCE($3,portal_preferences.receipt_emails),newsletter_opt_in=COALESCE($4,portal_preferences.newsletter_opt_in),updated_at=now()
			RETURNING receipt_emails AS "receiptEmails",newsletter_opt_in AS "newsletterOptIn"`,
				[claims.tenantId, claims.contactId, receipt ?? null, newsletter ?? null]
			);
			if (newsletter !== undefined) {
				await client.query(
					`UPDATE contacts SET data=jsonb_set(COALESCE(data,'{}'::jsonb),'{consent}',to_jsonb($3::boolean),true),updated_at=now()
				WHERE tenant_id=$1 AND id=$2`,
					[claims.tenantId, claims.contactId, newsletter]
				);
			}
			return result.rows[0];
		},
		pool
	);
}

export async function updatePortalProfile(
	cookie: string | undefined,
	input: {
		name: string;
		address: null | {
			line1: string;
			line2?: string;
			city: string;
			region: string;
			postalCode: string;
			country: string;
		};
	},
	pool: Pool = getPool()
) {
	const claims = cookie ? decodePortalSession(cookie) : null;
	if (!claims) throw new PortalError('Sign in to update your profile.', 401);
	return withTenant(
		claims.tenantId,
		async (client) => {
			const session = await client.query(
				'SELECT 1 FROM portal_sessions s JOIN contacts c ON c.tenant_id=s.tenant_id AND c.id=s.contact_id JOIN tenants t ON t.id=s.tenant_id AND t.suspended_at IS NULL WHERE s.tenant_id=$1 AND s.id=$2 AND s.contact_id=$3 AND s.token_hash=$4 AND s.revoked_at IS NULL AND s.expires_at>now() AND c.archived_at IS NULL AND c.merged_into IS NULL',
				[claims.tenantId, claims.id, claims.contactId, claims.tokenHash]
			);
			if (!session.rowCount) throw new PortalError('Sign in to update your profile.', 401);
			await client.query(
				'UPDATE contacts SET name=$3,updated_at=now() WHERE tenant_id=$1 AND id=$2',
				[claims.tenantId, claims.contactId, input.name.trim()]
			);
			if (input.address) {
				const existing = await client.query(
					'SELECT id FROM addresses WHERE tenant_id=$1 AND contact_id=$2 AND preferred=true ORDER BY updated_at DESC LIMIT 1',
					[claims.tenantId, claims.contactId]
				);
				if (existing.rowCount)
					await client.query(
						'UPDATE addresses SET line1=$3,line2=$4,city=$5,region=$6,postal_code=$7,country=$8,updated_at=now() WHERE tenant_id=$1 AND id=$2',
						[
							claims.tenantId,
							existing.rows[0].id,
							input.address.line1,
							input.address.line2 || '',
							input.address.city,
							input.address.region,
							input.address.postalCode,
							input.address.country.toUpperCase()
						]
					);
				else
					await client.query(
						"INSERT INTO addresses(tenant_id,contact_id,label,line1,line2,city,region,postal_code,country,preferred) VALUES($1,$2,'home',$3,$4,$5,$6,$7,$8,true)",
						[
							claims.tenantId,
							claims.contactId,
							input.address.line1,
							input.address.line2 || '',
							input.address.city,
							input.address.region,
							input.address.postalCode,
							input.address.country.toUpperCase()
						]
					);
			} else
				await client.query(
					'DELETE FROM addresses WHERE tenant_id=$1 AND contact_id=$2 AND preferred=true',
					[claims.tenantId, claims.contactId]
				);
			await client.query(
				"INSERT INTO audit_log(tenant_id,action,resource,record_id,details) VALUES($1,'portal.profile_updated','contacts',$2,$3)",
				[claims.tenantId, claims.contactId, { nameUpdated: true, addressUpdated: true }]
			);
			return { name: input.name.trim(), address: input.address };
		},
		pool
	);
}

export async function getPortalReceipt(
	cookie: string | undefined,
	giftId: string,
	pool: Pool = getPool()
) {
	const claims = cookie ? decodePortalSession(cookie) : null;
	if (!claims) throw new PortalError('Sign in to view donation acknowledgments.', 401);
	if (!/^[0-9a-f-]{36}$/i.test(giftId)) throw new PortalError('Acknowledgment not found.', 404);
	return withTenant(
		claims.tenantId,
		async (client) => {
			const verified = await client.query(
				'SELECT 1 FROM portal_sessions s JOIN contacts c ON c.tenant_id=s.tenant_id AND c.id=s.contact_id WHERE s.tenant_id=$1 AND s.id=$2 AND s.contact_id=$3 AND s.token_hash=$4 AND s.revoked_at IS NULL AND s.expires_at>now() AND c.archived_at IS NULL AND c.merged_into IS NULL',
				[claims.tenantId, claims.id, claims.contactId, claims.tokenHash]
			);
			if (!verified.rowCount)
				throw new PortalError('Sign in to view donation acknowledgments.', 401);
			const result = await client.query(
				`SELECT r.snapshot FROM gift_receipts r JOIN gifts g ON g.tenant_id=r.tenant_id AND g.id=r.gift_id
			WHERE r.tenant_id=$1 AND g.contact_id=$2 AND g.id=$3 AND g.correction_of IS NULL AND g.status='recorded'`,
				[claims.tenantId, claims.contactId, giftId]
			);
			if (!result.rowCount)
				throw new PortalError(
					'This acknowledgment is not ready yet, or is unavailable for this donation.',
					404
				);
			const snapshot = result.rows[0].snapshot as Record<string, unknown>;
			return {
				receiptNumber: String(snapshot.receiptNumber),
				organization: String(snapshot.organization),
				donorName: String(snapshot.donorName),
				amountMinor: safeMinorUnits(snapshot.amountMinor, 'Receipt amount'),
				currency: String(snapshot.currency),
				occurredAt: String(snapshot.occurredAt),
				campaignName: snapshot.campaignName ? String(snapshot.campaignName) : null,
				disclaimer: String(snapshot.disclaimer)
			};
		},
		pool
	);
}

export async function createPortalBillingSession(
	cookie: string | undefined,
	pool: Pool = getPool()
) {
	const claims = cookie ? decodePortalSession(cookie) : null;
	if (!claims) throw new PortalError('Sign in to manage recurring donations.', 401);
	const appUrl = env.PUBLIC_APP_URL || process.env.PUBLIC_APP_URL || '';
	if (!/^https:\/\//.test(appUrl) && process.env.NODE_ENV === 'production')
		throw new PortalError('Billing management is not configured.', 503);
	if (!appUrl) throw new PortalError('Billing management is not configured.', 503);
	const data = await withTenant(
		claims.tenantId,
		async (client) => {
			const session = await client.query(
				'SELECT 1 FROM portal_sessions s JOIN contacts c ON c.tenant_id=s.tenant_id AND c.id=s.contact_id JOIN tenants t ON t.id=s.tenant_id AND t.suspended_at IS NULL WHERE s.tenant_id=$1 AND s.id=$2 AND s.contact_id=$3 AND s.token_hash=$4 AND s.revoked_at IS NULL AND s.expires_at>now() AND c.archived_at IS NULL AND c.merged_into IS NULL',
				[claims.tenantId, claims.id, claims.contactId, claims.tokenHash]
			);
			if (!session.rowCount) throw new PortalError('Sign in to manage recurring donations.', 401);
			const rows = await client.query(
				`SELECT d.stripe_customer_id AS customer,a.connected_account_id AS "connectedAccountId"
			FROM donation_intents d JOIN stripe_accounts a ON a.tenant_id=d.tenant_id
			WHERE d.tenant_id=$1 AND d.contact_id=$2 AND d.stripe_customer_id IS NOT NULL AND d.stripe_subscription_id IS NOT NULL
			AND d.status IN ('active','past_due','incomplete') AND a.enabled=true AND a.disconnected_at IS NULL
			ORDER BY d.updated_at DESC LIMIT 1`,
				[claims.tenantId, claims.contactId]
			);
			return rows.rows[0] as { customer: string; connectedAccountId: string } | undefined;
		},
		pool
	);
	if (!data) throw new PortalError('No active recurring donation is available to manage.', 404);
	if (!env.STRIPE_PLATFORM_SECRET_KEY)
		throw new PortalError('Billing management is not configured.', 503);
	try {
		const stripe = stripeClient();
		const result = await stripe.billingPortal.sessions.create(
			{ customer: data.customer, return_url: `${appUrl.replace(/\/$/, '')}/portal` },
			{ stripeAccount: data.connectedAccountId }
		);
		return { url: result.url };
	} catch {
		throw new PortalError('Billing management is temporarily unavailable.', 503);
	}
}

export type PortalMailSender = (
	tenantId: string,
	message: { to: string; name: string; subject: string; text: string; idempotencyKey: string },
	pool?: Pool
) => Promise<{
	id: string;
	status: 'accepted' | 'already_accepted' | 'uncertain';
	providerMessageId?: string;
}>;

export async function handlePortalMagicLinkOutboxEvent(
	event: { tenantId: string; payload: unknown },
	pool: Pool,
	sendTransactionalEmail: PortalMailSender
) {
	const payload = event.payload as { magicLinkId?: unknown };
	if (typeof payload?.magicLinkId !== 'string' || !/^[0-9a-f-]{36}$/i.test(payload.magicLinkId))
		throw new Error('Portal link outbox payload is invalid');
	const pending = await withTenant(
		event.tenantId,
		async (client) => {
			const selected = await client.query(
				`SELECT l.id,l.contact_id,l.token_ciphertext,l.delivery_status,c.name,c.email,c.archived_at,c.merged_into,t.suspended_at
			FROM portal_magic_links l JOIN contacts c ON c.tenant_id=l.tenant_id AND c.id=l.contact_id
			JOIN tenants t ON t.id=l.tenant_id
			WHERE l.tenant_id=$1 AND l.id=$2 FOR UPDATE OF l`,
				[event.tenantId, payload.magicLinkId]
			);
			if (!selected.rowCount) return null;
			const row = selected.rows[0];
			if (row.suspended_at) {
				await client.query(
					"UPDATE portal_magic_links SET delivery_status='cancelled',token_ciphertext='' WHERE tenant_id=$1 AND id=$2 AND delivery_status IN ('queued','sending')",
					[event.tenantId, row.id]
				);
				return null;
			}
			if (
				row.delivery_status === 'sent' ||
				row.delivery_status === 'uncertain' ||
				row.delivery_status === 'cancelled'
			)
				return null;
			if (row.delivery_status === 'sending') {
				await client.query(
					"UPDATE portal_magic_links SET delivery_status='uncertain',token_ciphertext='' WHERE tenant_id=$1 AND id=$2",
					[event.tenantId, row.id]
				);
				return null;
			}
			if (
				row.archived_at ||
				row.merged_into ||
				!row.email ||
				!emailPattern.test(row.email) ||
				!row.token_ciphertext
			) {
				await client.query(
					"UPDATE portal_magic_links SET delivery_status='cancelled',token_ciphertext='' WHERE tenant_id=$1 AND id=$2",
					[event.tenantId, row.id]
				);
				return null;
			}
			const context = `${event.tenantId}:${row.id}`;
			const token = openToken(row.token_ciphertext, context);
			await client.query(
				"UPDATE portal_magic_links SET delivery_status='sending' WHERE tenant_id=$1 AND id=$2",
				[event.tenantId, row.id]
			);
			return {
				id: row.id,
				contactId: row.contact_id,
				email: row.email,
				name: row.name || 'there',
				token
			};
		},
		pool
	);
	if (!pending) return;
	const maySend = await withTenant(
		event.tenantId,
		async (client) => {
			const selected = await client.query(
				`SELECT 1 FROM portal_magic_links l JOIN tenants t ON t.id=l.tenant_id
				WHERE l.tenant_id=$1 AND l.id=$2 AND l.delivery_status='sending' AND t.suspended_at IS NULL`,
				[event.tenantId, pending.id]
			);
			return Boolean(selected.rowCount);
		},
		pool
	);
	if (!maySend) return;
	const base = env.PUBLIC_APP_URL || process.env.PUBLIC_APP_URL;
	if (!base || (process.env.NODE_ENV === 'production' && !base.startsWith('https://'))) {
		await withTenant(
			event.tenantId,
			(client) =>
				client
					.query(
						"UPDATE portal_magic_links SET delivery_status='uncertain',token_ciphertext='' WHERE tenant_id=$1 AND id=$2",
						[event.tenantId, pending.id]
					)
					.then(() => undefined),
			pool
		);
		throw new Error('Portal sign-in email is not configured.');
	}
	const url = `${base.replace(/\/$/, '')}/portal/verify/${encodeURIComponent(pending.token)}`;
	try {
		const result = await sendTransactionalEmail(
			event.tenantId,
			{
				to: pending.email,
				name: pending.name,
				subject: 'Your secure donor portal sign-in link',
				text: `Hello ${pending.name},\n\nUse this one-time link to sign in to your donor portal. It expires in 15 minutes.\n\n${url}\n\nIf you did not request this link, you can ignore this email.`,
				idempotencyKey: `portal.magic_link:${event.tenantId}:${pending.id}`
			},
			pool
		);
		const status =
			result.status === 'accepted' || result.status === 'already_accepted' ? 'sent' : 'uncertain';
		await withTenant(
			event.tenantId,
			(client) =>
				client
					.query(
						`UPDATE portal_magic_links SET delivery_status=$3,sent_at=CASE WHEN $3='sent' THEN now() ELSE sent_at END,token_ciphertext=''
			WHERE tenant_id=$1 AND id=$2 AND delivery_status='sending'`,
						[event.tenantId, pending.id, status]
					)
					.then(() => undefined),
			pool
		);
		if (status === 'uncertain')
			throw new Error('Portal sign-in email delivery is uncertain; automatic resend blocked.');
	} catch (error) {
		await withTenant(
			event.tenantId,
			(client) =>
				client
					.query(
						"UPDATE portal_magic_links SET delivery_status='uncertain',token_ciphertext='' WHERE tenant_id=$1 AND id=$2 AND delivery_status='sending'",
						[event.tenantId, pending.id]
					)
					.then(() => undefined),
			pool
		);
		throw error;
	}
}

export function portalTokenHash(token: string) {
	return sha256(token);
}
