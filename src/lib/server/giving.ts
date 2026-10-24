import { z } from 'zod';
import { randomUUID, createHash } from 'node:crypto';
import {
	tenantTransaction,
	financeRoles,
	editors,
	ServiceError,
	assertContact,
	serviceAudit,
	serviceEvent,
	type TenantSession
} from './tenant-service';
import { demoRead, demoWrite } from './demo-extensions';
import { demoAuthorization } from './tenant-service';
import { applyMutation } from './store';
import { safeMinorUnits } from './domain';
const uuid = z.string().uuid(),
	minor = z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
	currency = z
		.string()
		.length(3)
		.regex(/^[A-Z]{3}$/);
export const givingCommandSchema = z.discriminatedUnion('action', [
	z.object({
		action: z.literal('record'),
		requestKey: z.string().min(8).max(128),
		contactId: uuid.optional(),
		campaignId: uuid.optional(),
		fundId: uuid.optional(),
		amountMinor: minor,
		currency,
		kind: z.enum(['one_time', 'recurring', 'in_kind']).default('one_time'),
		method: z.enum(['cash', 'check', 'ach', 'wire', 'other', 'in_kind']).default('cash'),
		feeMinor: z.number().int().min(0).default(0),
		checkReference: z.string().max(100).optional(),
		designation: z.string().max(200).optional(),
		restricted: z.boolean().default(false),
		anonymous: z.boolean().default(false),
		inKindDescription: z.string().max(2000).optional(),
		occurredAt: z.string().datetime().optional(),
		tribute: z
			.object({
				kind: z.enum(['honor', 'memory']),
				honoree: z.string().min(1).max(150),
				notifyName: z.string().max(150).optional(),
				notifyEmail: z.string().email().optional()
			})
			.optional()
	}),
	z.object({
		action: z.literal('correction'),
		giftId: uuid,
		type: z.enum(['refund', 'dispute', 'reinstatement']),
		amountMinor: minor,
		reason: z.string().min(5).max(2000),
		requestKey: z.string().min(8).max(128),
		confirmed: z.literal(true)
	}),
	z.object({
		action: z.literal('pledge'),
		contactId: uuid,
		campaignId: uuid.optional(),
		amountMinor: minor,
		currency,
		dueAt: z.string().datetime(),
		description: z.string().max(2000).default(''),
		installments: z
			.array(z.object({ amountMinor: minor, dueAt: z.string().datetime() }))
			.min(1)
			.max(120)
	}),
	z.object({ action: z.literal('fulfill_installment'), installmentId: uuid, giftId: uuid }),
	z.object({
		action: z.literal('soft_credit'),
		giftId: uuid,
		contactId: uuid,
		amountMinor: minor,
		reason: z.string().min(1).max(1000)
	}),
	z.object({
		action: z.literal('matching'),
		giftId: uuid,
		organization: z.string().min(1).max(180),
		amountMinor: minor
	}),
	z.object({ action: z.literal('match_received'), matchId: uuid, matchedGiftId: uuid })
]);
function validateMoney(code: string) {
	try {
		if (!Intl.supportedValuesOf('currency').includes(code)) throw new Error();
	} catch {
		throw new ServiceError('Choose a supported ISO 4217 currency.');
	}
}
type GivingPageOptions = {
	cursor?: string;
	limit?: number;
	q?: string;
	kind?: string;
	month?: string;
	subscriptionCursor?: string;
};
function decodeGivingCursor(cursor?: string) {
	if (!cursor) return undefined;
	try {
		const [occurredAt, id] = Buffer.from(cursor, 'base64url').toString().split('|');
		if (
			!occurredAt ||
			!id ||
			!Number.isFinite(Date.parse(occurredAt)) ||
			!z.string().uuid().safeParse(id).success
		)
			throw new Error();
		return { occurredAt, id };
	} catch {
		throw new ServiceError('The giving page cursor is invalid.');
	}
}
export async function givingSnapshot(
	session: TenantSession,
	contactId?: string,
	options: GivingPageOptions = {}
) {
	const limit = Math.min(
		100,
		Math.max(1, Number.isInteger(options.limit) ? Number(options.limit) : 50)
	);
	const q = (options.q || '').trim().slice(0, 120);
	const kind =
		options.kind &&
		['one_time', 'recurring', 'in_kind', 'correction', 'pledge'].includes(options.kind)
			? options.kind
			: undefined;
	const cursor = decodeGivingCursor(options.cursor);
	const subscriptionCursor = decodeGivingCursor(options.subscriptionCursor);
	const monthMatch = options.month?.match(/^(\d{4})-(0[1-9]|1[0-2])$/);
	if (options.month && !monthMatch) throw new ServiceError('Choose a month in YYYY-MM format.');
	const monthStart = monthMatch
		? new Date(Date.UTC(Number(monthMatch[1]), Number(monthMatch[2]) - 1, 1))
		: undefined;
	const monthEnd = monthStart
		? new Date(Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth() + 1, 1))
		: undefined;
	if (session.demo) {
		const w = await demoAuthorization(session);
		let gifts = w.gifts.filter((g) => !contactId || g.contactId === contactId);
		if (monthStart)
			gifts = gifts.filter(
				(g: any) =>
					new Date(g.occurredAt || g.createdAt) >= monthStart &&
					new Date(g.occurredAt || g.createdAt) < monthEnd!
			);
		if (kind) gifts = gifts.filter((g: any) => g.kind === kind);
		if (q)
			gifts = gifts.filter((g: any) =>
				`${g.contactName || ''} ${g.campaignName || ''}`.toLowerCase().includes(q.toLowerCase())
			);
		gifts.sort(
			(a: any, b: any) =>
				String(b.occurredAt || '').localeCompare(String(a.occurredAt || '')) ||
				String(b.id).localeCompare(String(a.id))
		);
		const start = cursor
			? gifts.findIndex(
					(g: any) => String(g.occurredAt || '') === cursor.occurredAt && String(g.id) === cursor.id
				) + 1
			: 0;
		const page = gifts.slice(start, start + limit + 1);
		const visible = page.slice(0, limit);
		const out: Record<string, unknown> = {
			gifts: visible,
			nextCursor:
				page.length > limit && visible.length
					? Buffer.from(
							`${(visible.at(-1) as any).occurredAt}|${(visible.at(-1) as any).id}`
						).toString('base64url')
					: null,
			subscriptions: [],
			nextSubscriptionCursor: null,
			summary: [],
			pledges: [],
			installments: [],
			credits: [],
			matches: [],
			tributes: [],
			financialDetails: []
		};
		for (const name of [
			'pledges',
			'installments',
			'credits',
			'matches',
			'tributes',
			'financialDetails'
		])
			out[name] = (await demoRead(session, 'giving.' + name)).filter(
				(r) => !contactId || !r.contactId || r.contactId === contactId
			);
		return out;
	}
	return tenantTransaction(session, [...financeRoles, ...editors, 'analyst'], async (client, t) => {
		if (contactId) await assertContact(client, t.id, contactId);
		const baseValues: unknown[] = [t.id];
		let basePredicate = 'tenant_id=$1';
		if (contactId) {
			baseValues.push(contactId);
			basePredicate += ` AND (contact_id=$${baseValues.length} OR contact_id IN (SELECT id FROM contacts WHERE tenant_id=$1 AND merged_into=$${baseValues.length}))`;
		}
		if (monthStart) {
			baseValues.push(monthStart.toISOString(), monthEnd!.toISOString());
			basePredicate += ` AND occurred_at >= $${baseValues.length - 1}::timestamptz AND occurred_at < $${baseValues.length}::timestamptz`;
		}
		const summary = await client.query(
			`SELECT currency,COALESCE(sum(amount_minor) FILTER(WHERE status='recorded' AND kind NOT IN('correction','pledge')),0) gross,COALESCE(sum(amount_minor) FILTER(WHERE kind='correction' AND status='refunded'),0) refunds,COALESCE(sum(amount_minor) FILTER(WHERE kind='correction' AND status='disputed'),0) disputes,COALESCE(sum(amount_minor) FILTER(WHERE kind='correction' AND data->>'direction'='reinstatement' AND status='recorded'),0) reinstatements,count(*) FILTER(WHERE status='recorded' AND kind NOT IN('correction','pledge'))::int gift_count FROM gifts WHERE ${basePredicate} GROUP BY currency ORDER BY currency`,
			baseValues
		);
		const pageValues = [...baseValues];
		let pagePredicate = basePredicate;
		pagePredicate = 'g.' + pagePredicate;
		if (q) {
			pageValues.push(`%${q.replace(/[\\%_]/g, '\\$&')}%`);
			const n = pageValues.length;
			pagePredicate += ` AND (c.name ILIKE $${n} ESCAPE '\\' OR camp.name ILIKE $${n} ESCAPE '\\' OR g.id::text ILIKE $${n})`;
		}
		if (kind) {
			pageValues.push(kind);
			pagePredicate += ` AND g.kind=$${pageValues.length}`;
		}
		if (cursor) {
			pageValues.push(cursor.occurredAt, cursor.id);
			const n = pageValues.length;
			pagePredicate += ` AND (g.occurred_at,g.id)<($${n - 1}::timestamptz,$${n}::uuid)`;
		}
		pageValues.push(limit + 1);
		const rows = await client.query(
			`SELECT g.id,g.contact_id AS "contactId",g.campaign_id AS "campaignId",g.fund_id AS "fundId",g.amount_minor AS "amountMinor",g.currency,g.kind,g.status,g.occurred_at AS "occurredAt",g.occurred_at::text AS "occurredAtCursor",g.correction_of AS "correctionOf",g.data,c.name AS "contactName",camp.name AS "campaignName",COALESCE(fd.anonymous,false) AS anonymous FROM gifts g LEFT JOIN contacts c ON c.tenant_id=g.tenant_id AND c.id=g.contact_id LEFT JOIN campaigns camp ON camp.tenant_id=g.tenant_id AND camp.id=g.campaign_id LEFT JOIN donation_financial_details fd ON fd.tenant_id=g.tenant_id AND fd.gift_id=g.id WHERE ${pagePredicate} ORDER BY g.occurred_at DESC,g.id DESC LIMIT $${pageValues.length}`,
			pageValues
		);
		const hasMore = rows.rows.length > limit;
		const pageRows = rows.rows.slice(0, limit);
		const gifts = pageRows.map((r) => {
			const { data, ...row } = r;
			return {
				...data,
				...row,
				contactName: r.anonymous ? 'Anonymous' : r.contactName || 'Unassigned',
				amountMinor: safeMinorUnits(r.amountMinor)
			};
		});
		const giftIds = pageRows.map((r) => r.id);
		const pledgeValues: unknown[] = [t.id];
		let pledgeWhere = 'tenant_id=$1';
		if (contactId) {
			pledgeValues.push(contactId);
			pledgeWhere += ` AND contact_id=$${pledgeValues.length}`;
		}
		pledgeValues.push(101);
		const pledgeRows = await client.query(
			`SELECT p.id,p.contact_id AS "contactId",c.name AS "contactName",p.amount_minor AS "amountMinor",p.currency,p.status,p.due_at AS "dueAt",p.description FROM pledges p LEFT JOIN contacts c ON c.tenant_id=p.tenant_id AND c.id=p.contact_id WHERE ${pledgeWhere.replaceAll('tenant_id=', 'p.tenant_id=').replaceAll('contact_id=', 'p.contact_id=')} ORDER BY p.due_at DESC,p.id DESC LIMIT $${pledgeValues.length}`,
			pledgeValues
		);
		const subscriptionValues: any[] = [t.id];
		let subscriptionWhere =
			"di.tenant_id=$1 AND di.frequency IN('monthly','annual') AND di.status IN('active','past_due','ended')";
		if (contactId) {
			subscriptionValues.push(contactId);
			subscriptionWhere += ` AND (di.contact_id=$${subscriptionValues.length} OR di.contact_id IN(SELECT id FROM contacts WHERE tenant_id=$1 AND merged_into=$${subscriptionValues.length}))`;
		}
		if (subscriptionCursor) {
			subscriptionValues.push(subscriptionCursor.occurredAt, subscriptionCursor.id);
			subscriptionWhere += ` AND (di.created_at,di.id)<($${subscriptionValues.length - 1}::timestamptz,$${subscriptionValues.length}::uuid)`;
		}
		subscriptionValues.push(101);
		const subscriptionRows = await client.query(
			`SELECT di.id,di.contact_id AS "contactId",COALESCE(c.name,di.donor_name) AS "contactName",di.amount_minor AS "amountMinor",di.currency,di.frequency,di.status,di.created_at AS "createdAt",di.created_at::text AS "createdAtCursor",di.updated_at AS "updatedAt",di.succeeded_at AS "succeededAt" FROM donation_intents di LEFT JOIN contacts c ON c.tenant_id=di.tenant_id AND c.id=di.contact_id WHERE ${subscriptionWhere} ORDER BY di.created_at DESC,di.id DESC LIMIT $${subscriptionValues.length}`,
			subscriptionValues
		);
		const pledgeIds = pledgeRows.rows.slice(0, 100).map((r) => r.id);
		const childQueries = giftIds.length
			? await Promise.all([
					client.query(
						'SELECT id,gift_id AS "giftId",contact_id AS "contactId",amount_minor AS "amountMinor",reason FROM soft_credits WHERE tenant_id=$1 AND gift_id=ANY($2::uuid[]) LIMIT 200',
						[t.id, giftIds]
					),
					client.query(
						'SELECT id,gift_id AS "giftId",organization,amount_minor AS "amountMinor",status,matched_gift_id AS "matchedGiftId" FROM matching_gifts WHERE tenant_id=$1 AND gift_id=ANY($2::uuid[]) LIMIT 200',
						[t.id, giftIds]
					),
					client.query(
						'SELECT id,gift_id AS "giftId",honoree,kind FROM tributes WHERE tenant_id=$1 AND gift_id=ANY($2::uuid[]) LIMIT 200',
						[t.id, giftIds]
					),
					client.query(
						'SELECT gift_id AS "giftId",fee_minor AS "feeMinor",settlement_minor AS "settlementMinor",method,check_reference AS "checkReference",designation,restricted,in_kind_description AS "inKindDescription",anonymous FROM donation_financial_details WHERE tenant_id=$1 AND gift_id=ANY($2::uuid[]) LIMIT 200',
						[t.id, giftIds]
					)
				])
			: [{ rows: [] }, { rows: [] }, { rows: [] }, { rows: [] }];
		const installmentRows = pledgeIds.length
			? await client.query(
					'SELECT i.id,i.pledge_id AS "pledgeId",i.amount_minor AS "amountMinor",i.due_at AS "dueAt",i.gift_id AS "giftId" FROM pledge_installments i WHERE i.tenant_id=$1 AND i.pledge_id=ANY($2::uuid[]) ORDER BY i.due_at LIMIT 500',
					[t.id, pledgeIds]
				)
			: { rows: [] };
		const relatedCountRows = await Promise.all([
			client.query(`SELECT count(*)::int AS count FROM pledges WHERE ${pledgeWhere}`, [
				...pledgeValues.slice(0, -1)
			]),
			pledgeIds.length
				? client.query(
						'SELECT count(*)::int AS count FROM pledge_installments WHERE tenant_id=$1 AND pledge_id=ANY($2::uuid[])',
						[t.id, pledgeIds]
					)
				: Promise.resolve({ rows: [{ count: 0 }] } as any),
			...childQueries.map((_, index) =>
				giftIds.length
					? client.query(
							`SELECT count(*)::int AS count FROM ${['soft_credits', 'matching_gifts', 'tributes', 'donation_financial_details'][index]} WHERE tenant_id=$1 AND gift_id=ANY($2::uuid[])`,
							[t.id, giftIds]
						)
					: Promise.resolve({ rows: [{ count: 0 }] } as any)
			)
		]);
		const convert = (list: any[]) =>
			list.map((r) => ({
				...r,
				...(r.amountMinor !== undefined ? { amountMinor: safeMinorUnits(r.amountMinor) } : {}),
				...(r.feeMinor !== undefined ? { feeMinor: safeMinorUnits(r.feeMinor) } : {}),
				...(r.settlementMinor !== undefined && r.settlementMinor !== null
					? { settlementMinor: safeMinorUnits(r.settlementMinor) }
					: {})
			}));
		const summaryRows = summary.rows.map((r) => {
			const grossMinor = safeMinorUnits(r.gross),
				refundMinor = safeMinorUnits(r.refunds),
				disputeMinor = safeMinorUnits(r.disputes),
				reinstatementMinor = safeMinorUnits(r.reinstatements);
			return {
				currency: r.currency,
				grossMinor,
				refundMinor,
				disputeMinor,
				reinstatementMinor,
				netRecordedMinor: grossMinor - refundMinor - disputeMinor + reinstatementMinor,
				giftCount: Number(r.gift_count)
			};
		});
		const last = pageRows.at(-1);
		const subscriptionPage = subscriptionRows.rows.slice(0, 100),
			subscriptionLast = subscriptionPage.at(-1);
		const result: Record<string, any> = {
			gifts,
			nextCursor:
				hasMore && last
					? Buffer.from(`${last.occurredAtCursor}|${last.id}`).toString('base64url')
					: null,
			nextSubscriptionCursor:
				subscriptionRows.rows.length > 100 && subscriptionLast
					? Buffer.from(`${subscriptionLast.createdAtCursor}|${subscriptionLast.id}`).toString(
							'base64url'
						)
					: null,
			subscriptions: convert(subscriptionPage),
			summary: summaryRows,
			pledges: convert(pledgeRows.rows.slice(0, 100)),
			installments: convert(installmentRows.rows),
			credits: convert(childQueries[0].rows),
			matches: convert(childQueries[1].rows),
			tributes: convert(childQueries[2].rows),
			financialDetails: convert(childQueries[3].rows),
			relatedCounts: {
				pledges: Number(relatedCountRows[0].rows[0].count),
				installments: Number(relatedCountRows[1].rows[0].count),
				softCredits: Number(relatedCountRows[2].rows[0].count),
				matches: Number(relatedCountRows[3].rows[0].count),
				tributes: Number(relatedCountRows[4].rows[0].count),
				financialDetails: Number(relatedCountRows[5].rows[0].count)
			},
			relatedDetailsTruncated: {
				pledges: Number(relatedCountRows[0].rows[0].count) > pledgeRows.rows.slice(0, 100).length,
				installments: Number(relatedCountRows[1].rows[0].count) > installmentRows.rows.length,
				softCredits: Number(relatedCountRows[2].rows[0].count) > childQueries[0].rows.length,
				matches: Number(relatedCountRows[3].rows[0].count) > childQueries[1].rows.length,
				tributes: Number(relatedCountRows[4].rows[0].count) > childQueries[2].rows.length,
				financialDetails: Number(relatedCountRows[5].rows[0].count) > childQueries[3].rows.length
			}
		};
		await serviceAudit(client, t.id, session.userId, 'giving.read', 'gifts', contactId);
		return result;
	});
}

const statementYearSchema = z.coerce.number().int().min(2000).max(new Date().getUTCFullYear());
const statementContactSchema = z.string().uuid();
const escapeHtml = (value: unknown) =>
	String(value ?? '').replace(
		/[&<>"']/g,
		(c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!
	);
export function renderGivingStatementHtml(statement: Record<string, any>) {
	const rows = statement.currencies
		.map(
			(row: any) =>
				`<tr><th>${escapeHtml(row.currency)}</th><td>${escapeHtml(formatStatementMoney(row.grossMinor, row.currency))}</td><td>${escapeHtml(formatStatementMoney(row.refundMinor, row.currency))}</td><td>${escapeHtml(formatStatementMoney(row.disputeMinor, row.currency))}</td><td>${escapeHtml(formatStatementMoney(row.reinstatedMinor, row.currency))}</td><td><strong>${escapeHtml(formatStatementMoney(row.netRecordedMinor, row.currency))}</strong></td></tr>`
		)
		.join('');
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(statement.year)} giving statement · ${escapeHtml(statement.organization)}</title><style>@page{margin:20mm}body{font:16px/1.5 system-ui,sans-serif;max-width:850px;margin:3rem auto;padding:0 1.25rem;color:#17211c}header{border-bottom:2px solid #6d8e78;padding-bottom:1rem}h1{font-size:1.8rem}table{border-collapse:collapse;width:100%;margin:2rem 0}th,td{text-align:right;padding:.7rem .5rem;border-bottom:1px solid #ccd4ce}th:first-child{text-align:left}thead th{font-size:.8rem}footer{font-size:.88rem;color:#425249;margin-top:3rem}.print{margin:1rem 0;padding:.5rem 1rem}@media print{body{margin:0}.print{display:none}}</style></head><body><header><h1>${escapeHtml(statement.organization)}</h1><p>Annual giving statement for ${escapeHtml(statement.year)}</p><p><strong>${escapeHtml(statement.donorName)}</strong></p></header><main><p>This statement summarizes gifts recorded from January 1 through December 31, ${escapeHtml(statement.year)}. Amounts are grouped by currency and are not converted.</p><table><thead><tr><th>Currency</th><th>Gross gifts</th><th>Refunds</th><th>Disputes</th><th>Reinstatements</th><th>Net recorded</th></tr></thead><tbody>${rows || '<tr><td colspan="6">No recorded gifts for this year.</td></tr>'}</tbody></table><footer><p>${escapeHtml(statement.disclaimer)}</p><p>Prepared ${escapeHtml(statement.preparedAt)}.</p></footer></main><button class="print" onclick="window.print()">Print statement</button></body></html>`;
}
function formatStatementMoney(minor: unknown, currency: string) {
	return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(
		safeMinorUnits(minor, 'Statement total') /
			10 **
				new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions()
					.maximumFractionDigits!
	);
}
export async function givingStatement(
	session: TenantSession,
	contactIdInput: unknown,
	yearInput: unknown
) {
	if (session?.demo)
		throw new ServiceError('Annual statements require an authenticated finance workspace.', 503);
	if (!financeRoles.includes(session?.role as any))
		throw new ServiceError(
			'Statement access is limited to finance staff and tenant administrators.',
			403
		);
	const contactId = statementContactSchema.parse(contactIdInput),
		year = statementYearSchema.parse(yearInput);
	return tenantTransaction(session, financeRoles, async (client, t) => {
		const donor = await client.query(
			'SELECT name FROM contacts WHERE tenant_id=$1 AND id=$2 AND archived_at IS NULL',
			[t.id, contactId]
		);
		if (!donor.rowCount) throw new ServiceError('Donor not found in your workspace.', 404);
		const gifts = await client.query(
			`SELECT id,amount_minor,currency,occurred_at FROM gifts WHERE tenant_id=$1 AND contact_id=$2 AND kind<>'correction' AND status='recorded' AND occurred_at >= make_date($3,1,1)::timestamptz AND occurred_at < make_date($3+1,1,1)::timestamptz ORDER BY occurred_at,id`,
			[t.id, contactId, year]
		);
		const byGift = new Map(gifts.rows.map((row) => [String(row.id), row]));
		const corrections = byGift.size
			? await client.query(
					`SELECT correction_of AS "giftId",amount_minor AS "amountMinor",status,data FROM gifts WHERE tenant_id=$1 AND correction_of=ANY($2::uuid[])`,
					[t.id, [...byGift.keys()]]
				)
			: { rows: [] as any[] };
		const totals = new Map<
			string,
			{
				currency: string;
				grossMinor: number;
				refundMinor: number;
				disputeMinor: number;
				reinstatedMinor: number;
				netRecordedMinor: number;
			}
		>();
		for (const gift of gifts.rows) {
			const currency = String(gift.currency).trim();
			let item = totals.get(currency);
			if (!item) {
				item = {
					currency,
					grossMinor: 0,
					refundMinor: 0,
					disputeMinor: 0,
					reinstatedMinor: 0,
					netRecordedMinor: 0
				};
				totals.set(currency, item);
			}
			item.grossMinor += safeMinorUnits(gift.amount_minor);
		}
		for (const correction of corrections.rows) {
			const gift = byGift.get(String(correction.giftId));
			if (!gift) continue;
			const item = totals.get(String(gift.currency).trim())!;
			const amount = safeMinorUnits(correction.amountMinor);
			if (correction.data?.direction === 'reinstatement') item.reinstatedMinor += amount;
			else if (correction.status === 'refunded') item.refundMinor += amount;
			else if (correction.status === 'disputed') item.disputeMinor += amount;
		}
		for (const item of totals.values())
			item.netRecordedMinor =
				item.grossMinor - item.refundMinor - item.disputeMinor + item.reinstatedMinor;
		await serviceAudit(
			client,
			t.id,
			session.userId,
			'giving.statement.export',
			'gifts',
			contactId,
			{ year }
		);
		return {
			organization: t.name,
			donorName: donor.rows[0].name,
			contactId,
			year,
			currencies: [...totals.values()].sort((a, b) => a.currency.localeCompare(b.currency)),
			disclaimer:
				'This is an acknowledgment of records maintained by the organization, not tax or legal advice. No goods or services statement or tax-deductibility determination is made here. Please retain original receipts and consult a qualified tax professional.',
			preparedAt: new Date().toISOString()
		};
	});
}
export async function givingCommand(session: TenantSession, input: unknown) {
	const command = givingCommandSchema.parse(input);
	if ('currency' in command) validateMoney(command.currency);
	if (command.action === 'record' && command.feeMinor > command.amountMinor)
		throw new ServiceError('Fees cannot exceed the gift amount.');
	if (
		command.action === 'pledge' &&
		command.installments.reduce((a, i) => a + i.amountMinor, 0) !== command.amountMinor
	)
		throw new ServiceError('Installments must reconcile to the pledged amount.');
	if (session.demo) {
		const w = await demoAuthorization(session, financeRoles);
		if (
			'contactId' in command &&
			command.contactId &&
			!w.contacts.some((c) => c.id === command.contactId)
		)
			throw new ServiceError('Contact not found.', 404);
		if (command.action === 'record') {
			if (command.kind === 'in_kind' && !command.inKindDescription)
				throw new ServiceError('Describe the in-kind contribution.');
			return (
				await applyMutation(session.tenantSlug, 'gifts', {
					contactId: command.contactId,
					campaignId: command.campaignId,
					amountMinor: command.amountMinor,
					currency: command.currency,
					kind: command.kind,
					status: 'recorded',
					method: command.method,
					anonymous: command.anonymous,
					occurredAt: command.occurredAt || new Date().toISOString()
				})
			).item;
		}
		return demoWrite(session, financeRoles, (records) => {
			const key =
				'giving.' +
				(
					{
						pledge: 'pledges',
						soft_credit: 'credits',
						matching: 'matches',
						correction: 'corrections',
						fulfill_installment: 'installments',
						match_received: 'matches'
					} as any
				)[command.action];
			records[key] ||= [];
			const item = { ...command, id: randomUUID(), createdAt: new Date().toISOString() };
			records[key].push(item);
			return item;
		});
	}
	return tenantTransaction(session, financeRoles, async (client, t) => {
		let result: any;
		const gift = async (id: string) => {
			const r = await client.query('SELECT * FROM gifts WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [
				t.id,
				id
			]);
			if (!r.rowCount) throw new ServiceError('Gift not found in your workspace.', 404);
			return r.rows[0];
		};
		if ('contactId' in command && command.contactId)
			await assertContact(client, t.id, command.contactId);
		if (command.action === 'record' || command.action === 'pledge') {
			if (command.campaignId) {
				const campaign = await client.query(
					'SELECT fund_id,currency FROM campaigns WHERE tenant_id=$1 AND id=$2',
					[t.id, command.campaignId]
				);
				if (!campaign.rowCount)
					throw new ServiceError('Campaign not found in your workspace.', 404);
				if (String(campaign.rows[0].currency).trim() !== command.currency)
					throw new ServiceError('Gift and campaign currencies must match.');
				if (
					command.action === 'record' &&
					campaign.rows[0].fund_id &&
					command.fundId &&
					campaign.rows[0].fund_id !== command.fundId
				)
					throw new ServiceError('Selected fund does not match the campaign fund.');
				if (command.action === 'record' && !command.fundId)
					command.fundId = campaign.rows[0].fund_id || undefined;
			}
			if (command.action === 'record' && command.fundId) {
				const fund = await client.query('SELECT active FROM funds WHERE tenant_id=$1 AND id=$2', [
					t.id,
					command.fundId
				]);
				if (!fund.rowCount || !fund.rows[0].active)
					throw new ServiceError('Fund is unavailable in your workspace.', 404);
			}
		}
		switch (command.action) {
			case 'record': {
				if (command.kind === 'in_kind' && !command.inKindDescription)
					throw new ServiceError('Describe the in-kind contribution.');
				const external = 'offline:' + createHash('sha256').update(command.requestKey).digest('hex');
				const old = await client.query(
					'SELECT g.id,g.contact_id,g.campaign_id,g.fund_id,g.amount_minor,g.currency,g.kind,g.occurred_at,d.fee_minor,d.method,d.check_reference,d.designation,d.restricted,d.in_kind_description,d.anonymous,tr.honoree AS tribute_honoree,tr.kind AS tribute_kind,tr.notify_name,tr.notify_email FROM gifts g LEFT JOIN donation_financial_details d ON d.tenant_id=g.tenant_id AND d.gift_id=g.id LEFT JOIN tributes tr ON tr.tenant_id=g.tenant_id AND tr.gift_id=g.id WHERE g.tenant_id=$1 AND g.external_event_id=$2',
					[t.id, external]
				);
				if (old.rowCount) {
					const row = old.rows[0],
						same =
							Number(row.amount_minor) === command.amountMinor &&
							String(row.currency).trim() === command.currency &&
							row.contact_id === (command.contactId || null) &&
							row.campaign_id === (command.campaignId || null) &&
							row.fund_id === (command.fundId || null) &&
							row.kind === command.kind &&
							Number(row.fee_minor) === command.feeMinor &&
							row.method === command.method &&
							(row.check_reference || '') === (command.checkReference || '') &&
							(row.designation || '') === (command.designation || '') &&
							row.restricted === command.restricted &&
							row.anonymous === command.anonymous &&
							(row.in_kind_description || '') === (command.inKindDescription || '') &&
							(!command.occurredAt ||
								new Date(row.occurred_at).toISOString() ===
									new Date(command.occurredAt).toISOString()) &&
							(row.tribute_honoree || '') === (command.tribute?.honoree || '') &&
							(row.tribute_kind || '') === (command.tribute?.kind || '') &&
							(row.notify_name || '') === (command.tribute?.notifyName || '') &&
							(row.notify_email || '') === (command.tribute?.notifyEmail || '');
					if (!same)
						throw new ServiceError('Idempotency key was used with different gift details.', 409);
					return { id: row.id, replayed: true };
				}
				const id = randomUUID();
				await client.query(
					"INSERT INTO gifts(tenant_id,id,contact_id,campaign_id,fund_id,amount_minor,currency,kind,status,occurred_at,external_event_id,data) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'recorded',$9,$10,$11)",
					[
						t.id,
						id,
						command.contactId || null,
						command.campaignId || null,
						command.fundId || null,
						command.amountMinor,
						command.currency,
						command.kind,
						command.occurredAt || new Date().toISOString(),
						external,
						{ source: 'offline', anonymous: command.anonymous }
					]
				);
				await client.query(
					'INSERT INTO donation_financial_details(tenant_id,gift_id,fee_minor,settlement_minor,method,check_reference,designation,restricted,in_kind_description,anonymous) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
					[
						t.id,
						id,
						command.feeMinor,
						command.amountMinor - command.feeMinor,
						command.method,
						command.checkReference || null,
						command.designation || null,
						command.restricted,
						command.inKindDescription || null,
						command.anonymous
					]
				);
				if (command.tribute)
					await client.query(
						'INSERT INTO tributes(tenant_id,gift_id,honoree,kind,notify_name,notify_email) VALUES($1,$2,$3,$4,$5,$6)',
						[
							t.id,
							id,
							command.tribute.honoree,
							command.tribute.kind,
							command.tribute.notifyName || null,
							command.tribute.notifyEmail || null
						]
					);
				await serviceEvent(
					client,
					t.id,
					'gift.recorded',
					{ resource: 'gifts', recordId: id, contactId: command.contactId },
					'gift.receipt:' + t.id + ':' + id
				);
				result = { id, recorded: true };
				break;
			}
			case 'correction': {
				const original = await gift(command.giftId);
				const replayKey =
					'correction:' + createHash('sha256').update(command.requestKey).digest('hex');
				const replay = await client.query(
					'SELECT id,correction_of,amount_minor,status,data FROM gifts WHERE tenant_id=$1 AND external_event_id=$2',
					[t.id, replayKey]
				);
				if (replay.rowCount) {
					const row = replay.rows[0],
						expectedStatus =
							command.type === 'refund'
								? 'refunded'
								: command.type === 'dispute'
									? 'disputed'
									: 'recorded';
					if (
						row.correction_of !== command.giftId ||
						Number(row.amount_minor) !== command.amountMinor ||
						row.status !== expectedStatus ||
						row.data?.correctionReason !== command.reason ||
						row.data?.direction !== (command.type === 'reinstatement' ? 'reinstatement' : 'debit')
					)
						throw new ServiceError(
							'Idempotency key was used with different correction details.',
							409
						);
					return { id: row.id, replayed: true };
				}
				if (original.kind === 'correction' || original.status !== 'recorded')
					throw new ServiceError('Corrections must reference a recorded original gift.', 409);
				if (command.amountMinor > safeMinorUnits(original.amount_minor))
					throw new ServiceError('A correction cannot exceed its original gift.');
				const status =
					command.type === 'refund'
						? 'refunded'
						: command.type === 'dispute'
							? 'disputed'
							: 'recorded';
				const prior = await client.query(
					"SELECT coalesce(sum(CASE WHEN data->>'direction'='reinstatement' THEN -amount_minor ELSE amount_minor END),0) AS total FROM gifts WHERE tenant_id=$1 AND correction_of=$2 AND (status IN ('refunded','disputed') OR data->>'direction'='reinstatement')",
					[t.id, command.giftId]
				);
				if (
					command.type !== 'reinstatement' &&
					Number(prior.rows[0].total) + command.amountMinor > Number(original.amount_minor)
				)
					throw new ServiceError('Cumulative corrections exceed the original gift.', 409);
				if (command.type === 'reinstatement') {
					const disputed = await client.query(
						"SELECT coalesce(sum(CASE WHEN status='disputed' THEN amount_minor ELSE -amount_minor END),0) AS balance FROM gifts WHERE tenant_id=$1 AND correction_of=$2 AND (status='disputed' OR data->>'direction'='reinstatement')",
						[t.id, command.giftId]
					);
					if (command.amountMinor > Number(disputed.rows[0].balance))
						throw new ServiceError('Reinstatement exceeds the outstanding disputed amount.', 409);
				}
				const key = 'correction:' + createHash('sha256').update(command.requestKey).digest('hex');
				const existing = await client.query(
					'SELECT id FROM gifts WHERE tenant_id=$1 AND external_event_id=$2',
					[t.id, key]
				);
				if (existing.rowCount) return { id: existing.rows[0].id, replayed: true };
				const id = randomUUID();
				await client.query(
					"INSERT INTO gifts(tenant_id,id,contact_id,campaign_id,fund_id,amount_minor,currency,kind,status,correction_of,external_event_id,data) VALUES($1,$2,$3,$4,$5,$6,$7,'correction',$8,$9,$10,$11)",
					[
						t.id,
						id,
						original.contact_id,
						original.campaign_id,
						original.fund_id,
						command.amountMinor,
						String(original.currency).trim(),
						status,
						command.giftId,
						key,
						{
							correctionReason: command.reason,
							direction: command.type === 'reinstatement' ? 'reinstatement' : 'debit',
							source: 'manual_correction'
						}
					]
				);
				result = { id, originalGiftId: command.giftId };
				break;
			}
			case 'pledge': {
				const id = randomUUID();
				await client.query(
					'INSERT INTO pledges(tenant_id,id,contact_id,campaign_id,amount_minor,currency,due_at,description) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
					[
						t.id,
						id,
						command.contactId,
						command.campaignId || null,
						command.amountMinor,
						command.currency,
						command.dueAt,
						command.description
					]
				);
				for (const installment of command.installments)
					await client.query(
						'INSERT INTO pledge_installments(tenant_id,pledge_id,amount_minor,due_at) VALUES($1,$2,$3,$4)',
						[t.id, id, installment.amountMinor, installment.dueAt]
					);
				result = { id };
				break;
			}
			case 'fulfill_installment': {
				const g = await gift(command.giftId);
				const i = await client.query(
					'SELECT i.*,p.contact_id,p.currency FROM pledge_installments i JOIN pledges p ON p.tenant_id=i.tenant_id AND p.id=i.pledge_id WHERE i.tenant_id=$1 AND i.id=$2 FOR UPDATE OF i',
					[t.id, command.installmentId]
				);
				if (!i.rowCount) throw new ServiceError('Installment not found.', 404);
				const installment = i.rows[0];
				if (installment.gift_id)
					throw new ServiceError('Installment has already been linked to a gift.', 409);
				if (
					g.contact_id !== installment.contact_id ||
					Number(g.amount_minor) !== Number(installment.amount_minor) ||
					g.currency !== installment.currency ||
					g.status !== 'recorded'
				)
					throw new ServiceError(
						'Gift donor, amount, currency and status must match the installment.',
						422
					);
				await client.query(
					'UPDATE pledge_installments SET gift_id=$3 WHERE tenant_id=$1 AND id=$2',
					[t.id, command.installmentId, command.giftId]
				);
				await client.query(
					"UPDATE pledges SET status='fulfilled' WHERE tenant_id=$1 AND id=$2 AND NOT EXISTS(SELECT 1 FROM pledge_installments WHERE tenant_id=$1 AND pledge_id=$2 AND gift_id IS NULL)",
					[t.id, installment.pledge_id]
				);
				result = { linked: true };
				break;
			}
			case 'soft_credit': {
				const g = await gift(command.giftId);
				if (
					command.amountMinor > Number(g.amount_minor) ||
					g.kind === 'correction' ||
					g.status !== 'recorded'
				)
					throw new ServiceError(
						'Soft credit must reference an original gift and cannot exceed its amount.'
					);
				const existing = await client.query(
					'SELECT id,amount_minor,reason FROM soft_credits WHERE tenant_id=$1 AND gift_id=$2 AND contact_id=$3',
					[t.id, command.giftId, command.contactId]
				);
				if (existing.rowCount) {
					if (
						Number(existing.rows[0].amount_minor) !== command.amountMinor ||
						existing.rows[0].reason !== command.reason
					)
						throw new ServiceError(
							'This gift already has a different soft credit for that supporter.',
							409
						);
					result = { id: existing.rows[0].id, replayed: true };
					break;
				}
				const credited = await client.query(
					'SELECT coalesce(sum(amount_minor),0) AS total FROM soft_credits WHERE tenant_id=$1 AND gift_id=$2',
					[t.id, command.giftId]
				);
				if (Number(credited.rows[0].total) + command.amountMinor > Number(g.amount_minor))
					throw new ServiceError('Combined soft credits cannot exceed the original gift.', 409);
				result = (
					await client.query(
						'INSERT INTO soft_credits(tenant_id,gift_id,contact_id,amount_minor,reason) VALUES($1,$2,$3,$4,$5) RETURNING id',
						[t.id, command.giftId, command.contactId, command.amountMinor, command.reason]
					)
				).rows[0];
				break;
			}
			case 'matching':
				await gift(command.giftId);
				result = (
					await client.query(
						'INSERT INTO matching_gifts(tenant_id,gift_id,organization,amount_minor) VALUES($1,$2,$3,$4) RETURNING id',
						[t.id, command.giftId, command.organization, command.amountMinor]
					)
				).rows[0];
				break;
			case 'match_received': {
				const g = await gift(command.matchedGiftId);
				const m = await client.query(
					'SELECT * FROM matching_gifts WHERE tenant_id=$1 AND id=$2 FOR UPDATE',
					[t.id, command.matchId]
				);
				if (!m.rowCount) throw new ServiceError('Matching-gift request not found.', 404);
				if (g.status !== 'recorded' || Number(g.amount_minor) !== Number(m.rows[0].amount_minor))
					throw new ServiceError('Matching gift must reconcile to a recorded payment.');
				await client.query(
					"UPDATE matching_gifts SET status='received',matched_gift_id=$3 WHERE tenant_id=$1 AND id=$2",
					[t.id, command.matchId, command.matchedGiftId]
				);
				result = { matched: true };
				break;
			}
		}
		await serviceAudit(
			client,
			t.id,
			session.userId,
			'giving.' + command.action,
			'gifts',
			result.id,
			{ action: command.action }
		);
		return result;
	});
}
