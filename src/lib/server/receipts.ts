import type { Pool, PoolClient } from 'pg';
import { getPool, workspaceFromPostgres } from './database';
import { safeMinorUnits } from './domain';

type Session = { userId: string; tenantSlug: string; role: string; demo?: boolean };
type OutboxEvent = { tenantId: string; payload: unknown };
const receiptRoles = new Set(['owner', 'admin', 'finance_manager', 'finance']);

export class ReceiptError extends Error {
	constructor(
		message: string,
		readonly status: number
	) {
		super(message);
		this.name = 'ReceiptError';
	}
}

async function withTenant<T>(
	pool: Pool,
	tenantId: string,
	userId: string,
	callback: (client: PoolClient) => Promise<T>
) {
	const client = await pool.connect();
	try {
		await client.query('BEGIN');
		await client.query("SELECT set_config('app.tenant_id',$1,true)", [tenantId]);
		const member = await client.query(
			"SELECT 1 FROM memberships WHERE tenant_id=$1 AND user_id=$2 AND status='active'",
			[tenantId, userId]
		);
		if (!member.rowCount) throw new ReceiptError('Active tenant membership is unavailable.', 403);
		const value = await callback(client);
		await client.query('COMMIT');
		return value;
	} catch (error) {
		await client.query('ROLLBACK').catch(() => undefined);
		throw error;
	} finally {
		client.release();
	}
}

function escapeHtml(value: unknown): string {
	return String(value ?? '').replace(
		/[&<>"']/g,
		(character) =>
			({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!
	);
}

export function renderGiftReceiptHtml(snapshot: Record<string, unknown>): string {
	const campaignLine = snapshot.campaignName
		? `<p><strong>Designation:</strong> ${escapeHtml(snapshot.campaignName)}</p>`
		: '';
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Donation acknowledgment ${escapeHtml(snapshot.receiptNumber)}</title><style>body{font:16px/1.55 system-ui,sans-serif;max-width:42rem;margin:3rem auto;padding:0 1.25rem;color:#17211c}h1{font-size:1.6rem}header{border-bottom:1px solid #ccd4ce;padding-bottom:1.5rem;margin-bottom:2rem}.amount{font-size:1.5rem;font-weight:700}.note{font-size:.9rem;color:#425249;margin-top:3rem}</style></head><body><header><h1>${escapeHtml(snapshot.organization)}</h1><p>Donation acknowledgment</p><p>Receipt ${escapeHtml(snapshot.receiptNumber)}</p></header><main><p>Received from <strong>${escapeHtml(snapshot.donorName)}</strong></p><p class="amount">${escapeHtml(snapshot.amountDisplay)}</p><p>Gift date: ${escapeHtml(snapshot.giftDate)}</p>${campaignLine}<p>${escapeHtml(snapshot.thankYouMessage)}</p><p class="note">${escapeHtml(snapshot.disclaimer)}</p></main></body></html>`;
}

function authorize(session: Session) {
	if (!session) throw new ReceiptError('Sign in to view receipts.', 401);
	if (session.demo) throw new ReceiptError('Receipts are unavailable in demo mode.', 503);
	if (!receiptRoles.has(session.role))
		throw new ReceiptError(
			'Receipt access is limited to finance staff and tenant administrators.',
			403
		);
}

export async function listGiftReceipts(
	session: Session,
	contactId?: string,
	pool: Pool = getPool()
) {
	authorize(session);
	if (
		contactId &&
		!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(contactId)
	)
		throw new ReceiptError('contactId must be a UUID.', 400);
	const workspace = await workspaceFromPostgres(session.tenantSlug, session.userId, session.role);
	if (!workspace) throw new ReceiptError('Active tenant membership is unavailable.', 403);
	return withTenant(pool, workspace.tenant.id, session.userId, async (client) => {
		const result = await client.query(
			`SELECT r.id,r.gift_id AS "giftId",r.created_at AS "createdAt",r.snapshot,
			g.contact_id AS "contactId",g.amount_minor AS "amountMinor",g.currency,g.occurred_at AS "occurredAt"
			FROM gift_receipts r JOIN gifts g ON g.tenant_id=r.tenant_id AND g.id=r.gift_id
			WHERE r.tenant_id=$1 AND ($2::uuid IS NULL OR g.contact_id=$2)
			ORDER BY r.created_at DESC LIMIT 100`,
			[workspace.tenant.id, contactId ?? null]
		);
		return {
			receipts: result.rows.map((row) => ({
				id: row.id,
				giftId: row.giftId,
				contactId: row.contactId,
				receiptNumber: (row.snapshot as Record<string, unknown>).receiptNumber,
				donorName: (row.snapshot as Record<string, unknown>).donorName,
				amountMinor: safeMinorUnits(row.amountMinor, 'Receipt amount'),
				currency: row.currency,
				occurredAt: row.occurredAt,
				createdAt: row.createdAt
			}))
		};
	});
}

export async function getGiftReceiptHtml(session: Session, id: string, pool: Pool = getPool()) {
	authorize(session);
	if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))
		throw new ReceiptError('Receipt not found.', 404);
	const workspace = await workspaceFromPostgres(session.tenantSlug, session.userId, session.role);
	if (!workspace) throw new ReceiptError('Active tenant membership is unavailable.', 403);
	const snapshot = await withTenant(pool, workspace.tenant.id, session.userId, async (client) => {
		const result = await client.query(
			'SELECT snapshot FROM gift_receipts WHERE tenant_id=$1 AND id=$2',
			[workspace.tenant.id, id]
		);
		if (!result.rowCount) throw new ReceiptError('Receipt not found.', 404);
		return result.rows[0].snapshot as Record<string, unknown>;
	});
	const html = renderGiftReceiptHtml(snapshot);
	return { html, receiptNumber: String(snapshot.receiptNumber) };
}

/** Create one immutable acknowledgement snapshot for each eligible recorded gift. */
export async function handleGiftRecordedOutboxEvent(event: OutboxEvent, pool: Pool) {
	const payload = event.payload as { resource?: unknown; recordId?: unknown };
	if (
		payload?.resource !== 'gifts' ||
		typeof payload.recordId !== 'string' ||
		!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
			payload.recordId
		)
	)
		throw new Error('Gift receipt outbox payload is invalid');
	const client = await pool.connect();
	try {
		await client.query('BEGIN');
		await client.query("SELECT set_config('app.tenant_id',$1,true)", [event.tenantId]);
		const result = await client.query(
			`SELECT g.id,g.contact_id,g.amount_minor,g.currency,g.occurred_at,g.kind,g.status,g.correction_of,g.data,
			c.name AS "donorName",ca.name AS "campaignName",ca.receipt_template AS "receiptTemplate",t.legal_name AS organization
			FROM gifts g JOIN tenants t ON t.id=g.tenant_id
			LEFT JOIN contacts c ON c.tenant_id=g.tenant_id AND c.id=g.contact_id
			LEFT JOIN campaigns ca ON ca.tenant_id=g.tenant_id AND ca.id=g.campaign_id
			WHERE g.tenant_id=$1 AND g.id=$2 FOR SHARE OF g`,
			[event.tenantId, payload.recordId]
		);
		if (!result.rowCount) throw new Error('Recorded gift was not found for receipt generation');
		const gift = result.rows[0];
		if (gift.status !== 'recorded' || gift.correction_of) {
			await client.query('COMMIT');
			return;
		}
		const currency = String(gift.currency).toUpperCase();
		const amountMinor = safeMinorUnits(gift.amount_minor, 'Gift amount');
		let amount: string;
		try {
			const fractionDigits = new Intl.NumberFormat('en-US', {
				style: 'currency',
				currency
			}).resolvedOptions().maximumFractionDigits;
			amount = (amountMinor / 10 ** (fractionDigits ?? 2)).toLocaleString('en-US', {
				style: 'currency',
				currency
			});
		} catch {
			amount = `${amountMinor.toLocaleString('en-US')} ${currency} minor units`;
		}
		const giftDate = new Date(gift.occurred_at).toLocaleDateString('en-US', {
			timeZone: 'UTC',
			year: 'numeric',
			month: 'long',
			day: 'numeric',
			timeZoneName: 'short'
		});
		const snapshot = {
			receiptNumber: `G-${String(gift.id).slice(0, 8).toUpperCase()}`,
			organization: String(gift.organization),
			donorName: String(gift.donorName || gift.data?.donorName || 'Anonymous donor'),
			amountDisplay: amount,
			amountMinor,
			currency,
			giftDate,
			occurredAt: new Date(gift.occurred_at).toISOString(),
			campaignName: gift.campaignName ? String(gift.campaignName) : null,
			thankYouMessage:
				typeof gift.receiptTemplate?.thankYouMessage === 'string'
					? gift.receiptTemplate.thankYouMessage
					: 'Thank you for supporting our work.',
			disclaimer:
				typeof gift.receiptTemplate?.disclaimer === 'string'
					? gift.receiptTemplate.disclaimer
					: 'Donation acknowledgment only. This is not tax advice or a determination of deductibility. Consult your tax professional regarding your circumstances.'
		};
		const inserted = await client.query(
			'INSERT INTO gift_receipts(tenant_id,gift_id,snapshot) VALUES($1,$2,$3) ON CONFLICT(tenant_id,gift_id) DO NOTHING RETURNING id',
			[event.tenantId, gift.id, snapshot]
		);
		if (inserted.rowCount)
			await client.query(
				'INSERT INTO audit_log(tenant_id,action,resource,record_id,details) VALUES($1,$2,$3,$4,$5)',
				[
					event.tenantId,
					'gift.receipt_generated',
					'gift_receipts',
					inserted.rows[0].id,
					{ giftId: gift.id }
				]
			);
		await client.query('COMMIT');
	} catch (error) {
		await client.query('ROLLBACK').catch(() => undefined);
		throw error;
	} finally {
		client.release();
	}
}
