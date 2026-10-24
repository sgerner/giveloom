import { z } from 'zod';
import { segmentMatches } from './communications';
import { insightReport, type GiftRow } from '$lib/reporting';
import { canonicalContactId } from '$lib/identity';
import {
	demoAuthorization,
	tenantTransaction,
	serviceAudit,
	ServiceError,
	type TenantSession
} from './tenant-service';
import { demoRead } from './demo-extensions';
const roles = [
	'owner',
	'admin',
	'finance',
	'finance_manager',
	'fundraising_manager',
	'fundraiser',
	'analyst'
];
export const insightFilterSchema = z.object({
	from: z.iso.date().optional(),
	to: z.iso.date().optional(),
	currency: z.string().length(3).optional(),
	campaignId: z.uuid().optional(),
	fundId: z.uuid().optional(),
	ownerId: z.uuid().optional(),
	segmentId: z.uuid().optional(),
	year: z.coerce.number().int().min(1900).max(2200).optional(),
	campaignCostMinor: z.coerce.number().int().nonnegative().max(1e15).optional()
});
export async function reportingInsights(session: TenantSession, input: unknown) {
	const filter = insightFilterSchema.parse(input);
	if (filter.from && filter.to && filter.from > filter.to)
		throw new ServiceError('Start date must precede end date.', 422);
	if (session.demo) {
		const w = await demoAuthorization(session, roles);
		return insightReport(
			{
				gifts: w.gifts as GiftRow[],
				contacts: w.contacts as any,
				prospects: w.prospects as any,
				introductions: w.introductions as any,
				details: (await demoRead(session, 'giving.details')) as any,
				pledges: (await demoRead(session, 'giving.pledges')) as any
			},
			{ ...filter, currency: filter.currency || w.tenant.currency }
		);
	}
	return tenantTransaction(session, roles, async (client, t) => {
		const [gifts, aliases, contacts, details, subs, pledges, proposals, records, email] =
			await Promise.all([
				client.query(
					'SELECT id,contact_id AS "contactId",campaign_id AS "campaignId",fund_id AS "fundId",amount_minor::float8 AS "amountMinor",currency,kind,status,occurred_at AS "occurredAt",created_at AS "createdAt",data FROM gifts WHERE tenant_id=$1',
					[t.id]
				),
				client.query(
					'SELECT id,merged_into AS "mergedInto" FROM contacts WHERE tenant_id=$1 AND merged_into IS NOT NULL',
					[t.id]
				),
				client.query('SELECT id,name,email,stage,tags,data FROM contacts WHERE tenant_id=$1', [
					t.id
				]),
				client.query(
					'SELECT gift_id AS "giftId",fee_minor::float8 AS "feeMinor",settlement_minor::float8 AS "settledMinor" FROM donation_financial_details WHERE tenant_id=$1',
					[t.id]
				),
				client.query(
					'SELECT id,contact_id AS "contactId",campaign_id AS "campaignId",fund_id AS "fundId",amount_minor::float8 AS "amountMinor",currency,frequency,status FROM donation_intents WHERE tenant_id=$1 AND frequency<>\'once\'',
					[t.id]
				),
				client.query(
					'SELECT p.contact_id AS "contactId",p.campaign_id AS "campaignId",(p.amount_minor-coalesce((SELECT sum(i.amount_minor) FROM pledge_installments i WHERE i.tenant_id=p.tenant_id AND i.pledge_id=p.id AND i.gift_id IS NOT NULL),0))::float8 AS "amountMinor",currency,status FROM pledges p WHERE tenant_id=$1',
					[t.id]
				),
				client.query(
					'SELECT contact_id AS "contactId",owner_id AS "ownerId",ask_minor::float8 AS "askMinor",currency,stage FROM proposals WHERE tenant_id=$1',
					[t.id]
				),
				client.query(
					"SELECT resource,id,data FROM workspace_records WHERE tenant_id=$1 AND resource IN ('introductions','segments') AND archived_at IS NULL UNION ALL SELECT 'prospects' AS resource,id,data||jsonb_build_object('stage',stage) FROM prospects WHERE tenant_id=$1",
					[t.id]
				),
				client.query(
					'SELECT status,count(*)::int AS count FROM email_messages WHERE tenant_id=$1 GROUP BY status',
					[t.id]
				)
			]);
		let segmentIds: string[] | undefined;
		if (filter.segmentId) {
			const segment = records.rows.find(
				(r) => r.resource === 'segments' && r.id === filter.segmentId
			);
			if (!segment) throw new ServiceError('Segment not found.', 404);
			segmentIds = contacts.rows
				.filter((c) => segmentMatches({ ...c.data, ...c }, segment.data.rules || segment.data))
				.map((c) => c.id);
		}
		const filteredContacts =
			filter.ownerId || filter.segmentId
				? contacts.rows.filter((c) => {
						const ownerMatches = !filter.ownerId || c.data?.ownerId === filter.ownerId;
						const segmentMatchesContact = !segmentIds || segmentIds.includes(c.id);
						return ownerMatches && segmentMatchesContact;
					})
				: null;
		const audienceContactIds = filteredContacts?.map((c) => c.id) ?? null;
		const result = insightReport(
			{
				gifts: gifts.rows.map((g) => ({
					...g.data,
					...g,
					contactId: g.contactId ? canonicalContactId(g.contactId, aliases.rows) : undefined,
					currency: String(g.currency).trim()
				})),
				contacts: contacts.rows.map((c) => ({ id: c.id, ...c.data })),
				details: details.rows,
				subscriptions: subs.rows.map((s) => ({ ...s, currency: s.currency.trim() })),
				pledges: pledges.rows.map((p) => ({ ...p, currency: p.currency.trim() })),
				proposals: proposals.rows.map((p) => ({ ...p, currency: p.currency.trim() })),
				prospects: records.rows.filter((r) => r.resource === 'prospects').map((r) => r.data),
				introductions: records.rows
					.filter((r) => r.resource === 'introductions')
					.map((r) => r.data),
				email: email.rows
			},
			{ ...filter, segmentIds, currency: filter.currency || t.currency }
		);
		const board = await client.query(
			"SELECT count(*)::int AS assigned,count(*) FILTER(WHERE x.status='completed')::int AS completed,count(DISTINCT x.assigned_to)::int AS members FROM tasks x JOIN memberships m ON m.tenant_id=x.tenant_id AND m.user_id=x.assigned_to WHERE x.tenant_id=$1 AND m.role IN ('board_member','volunteer') AND ($2::timestamptz IS NULL OR x.created_at >= $2) AND ($3::timestamptz IS NULL OR x.created_at < $3::date+interval '1 day')",
			[t.id, filter.from || null, filter.to || null]
		);
		const periodFrom = filter.from || new Date().toISOString().slice(0, 7) + '-01',
			periodTo = filter.to || new Date().toISOString().slice(0, 10);
		const churn = await client.query(
			`WITH scoped AS (SELECT id FROM donation_intents d WHERE d.tenant_id=$1 AND d.currency=$4 AND d.frequency<>'once' AND ($5::uuid IS NULL OR d.campaign_id=$5) AND ($6::uuid IS NULL OR d.fund_id=$6) AND ($7::uuid[] IS NULL OR d.contact_id=ANY($7))), prior AS (SELECT DISTINCT ON(e.donation_intent_id) e.donation_intent_id,e.new_status FROM recurring_status_events e JOIN scoped d ON d.id=e.donation_intent_id WHERE e.tenant_id=$1 AND e.effective_at < $2::date ORDER BY e.donation_intent_id,e.effective_at DESC,e.id DESC), ended AS (SELECT DISTINCT e.donation_intent_id FROM recurring_status_events e JOIN scoped d ON d.id=e.donation_intent_id WHERE e.tenant_id=$1 AND e.effective_at >= $2::date AND e.effective_at < $3::date+interval '1 day' AND e.previous_status='active' AND e.new_status='ended') SELECT (SELECT count(*)::int FROM prior WHERE new_status='active') AS "activeAtStart",(SELECT count(*)::int FROM ended JOIN prior USING(donation_intent_id) WHERE prior.new_status='active') AS churned,(SELECT count(DISTINCT e.donation_intent_id)::int FROM recurring_status_events e JOIN scoped d ON d.id=e.donation_intent_id WHERE e.tenant_id=$1) AS "historyCoverage"`,
			[
				t.id,
				periodFrom,
				periodTo,
				result.currency,
				filter.campaignId || null,
				filter.fundId || null,
				audienceContactIds
			]
		);
		const churnRow = churn.rows[0];
		Object.assign(result, {
			boardEngagement: result.boardEngagement === null ? null : board.rows[0],
			recurringChurn: {
				...churnRow,
				from: periodFrom,
				to: periodTo,
				rate: churnRow.activeAtStart ? churnRow.churned / churnRow.activeAtStart : null,
				definition:
					'Subscribers active immediately before the period who recorded an active-to-ended event during it, divided by the active starting cohort. Currency, campaign, fund and selected contact audience filters apply. Status-history coverage is limited to that same scoped subscription cohort; historical gaps are not inferred.'
			}
		});
		await serviceAudit(client, t.id, session.userId, 'report.read', 'insights', undefined, {
			filters: filter
		});
		return result;
	});
}
