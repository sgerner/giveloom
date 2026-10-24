import type { PoolClient } from 'pg';
import { safeMinorUnits } from './domain';

export type HouseholdGivingTotal = {
	currency: string;
	grossMinor: number;
	refundMinor: number;
	disputeMinor: number;
	reinstatedMinor: number;
	netRecordedMinor: number;
	giftCount: number;
};

export function summarizeDemoHouseholdGiving(
	households: Array<{ id: string; memberIds?: string[] }>,
	aliases: Array<{ id: string; mergedInto: string }>,
	gifts: Array<Record<string, any>>
): Map<string, HouseholdGivingTotal[]> {
	const mergedInto = new Map(aliases.map((alias) => [alias.id, alias.mergedInto]));
	const mergedSources = new Map<string, string[]>();
	for (const alias of aliases)
		mergedSources.set(alias.mergedInto, [...(mergedSources.get(alias.mergedInto) || []), alias.id]);
	const result = new Map<string, HouseholdGivingTotal[]>();
	for (const household of households) {
		const members = new Set<string>();
		const queue = [...(household.memberIds || [])].map((id) => ({ id, depth: 0 }));
		while (queue.length) {
			const next = queue.shift()!;
			if (next.depth > 32 || members.has(next.id)) continue;
			members.add(next.id);
			const parent = mergedInto.get(next.id);
			if (parent) queue.push({ id: parent, depth: next.depth + 1 });
			for (const source of mergedSources.get(next.id) || [])
				queue.push({ id: source, depth: next.depth + 1 });
		}
		const events = new Map<string, HouseholdGivingTotal>();
		const hardGiftRows = gifts.filter(
			(gift) =>
				members.has(String(gift.contactId || '')) &&
				gift.status === 'recorded' &&
				!['correction', 'pledge', 'soft_credit'].includes(String(gift.kind))
		);
		const hardGifts = [
			...new Map(
				hardGiftRows.map((gift, index) => [
					String(gift.id ?? `${gift.contactId}:${gift.currency}:${gift.occurredAt ?? index}`),
					gift
				])
			).values()
		];
		for (const gift of hardGifts) {
			const currency = String(gift.currency || 'USD').trim();
			const row = events.get(currency) || {
				currency,
				grossMinor: 0,
				refundMinor: 0,
				disputeMinor: 0,
				reinstatedMinor: 0,
				netRecordedMinor: 0,
				giftCount: 0
			};
			row.grossMinor += safeMinorUnits(gift.amountMinor || 0, 'Household giving');
			row.giftCount++;
			events.set(currency, row);
			const corrections = new Map(
				gifts
					.filter((item) => item.correctionOf === gift.id && item.kind === 'correction')
					.map((item, index) => [String(item.id ?? `${gift.id}:correction:${index}`), item])
			);
			for (const correction of corrections.values()) {
				const direction = correction.data?.direction ?? correction.direction;
				if (direction === 'reinstatement' && correction.status === 'recorded')
					row.reinstatedMinor += safeMinorUnits(
						correction.amountMinor || 0,
						'Household reinstatements'
					);
				else if (correction.status === 'refunded')
					row.refundMinor += safeMinorUnits(correction.amountMinor || 0, 'Household refunds');
				else if (correction.status === 'disputed')
					row.disputeMinor += safeMinorUnits(correction.amountMinor || 0, 'Household disputes');
			}
		}
		const totals = [...events.values()].sort((a, b) => a.currency.localeCompare(b.currency));
		for (const row of totals)
			row.netRecordedMinor =
				row.grossMinor - row.refundMinor - row.disputeMinor + row.reinstatedMinor;
		result.set(household.id, totals);
	}
	return result;
}

/** Full-ledger hard-credit totals; member aliases and duplicate household IDs resolve once. */
export async function householdGivingSummaries(
	client: PoolClient,
	tenantId: string,
	householdIds: string[]
): Promise<Map<string, HouseholdGivingTotal[]>> {
	if (!householdIds.length) return new Map();
	const result = await client.query(
		`WITH RECURSIVE households AS (
			SELECT id,data FROM workspace_records
			WHERE tenant_id=$1 AND resource='households' AND archived_at IS NULL AND id=ANY($2::uuid[])
		), raw_members AS (
			SELECT h.id AS household_id, m.member_id
			FROM households h
			CROSS JOIN LATERAL (
				SELECT DISTINCT value::uuid AS member_id
				FROM jsonb_array_elements_text(COALESCE(h.data->'memberIds','[]'::jsonb)) AS value
			) m
		), member_contact_closure(household_id,contact_id,path,depth) AS (
			SELECT rm.household_id,c.id,ARRAY[c.id],0
			FROM raw_members rm JOIN contacts c ON c.tenant_id=$1 AND c.id=rm.member_id
			UNION ALL
			SELECT closure.household_id,c.id,closure.path||c.id,closure.depth+1
			FROM member_contact_closure closure
			JOIN contacts current ON current.tenant_id=$1 AND current.id=closure.contact_id
			JOIN contacts c ON c.tenant_id=$1 AND (c.id=current.merged_into OR c.merged_into=current.id)
			WHERE closure.depth<32 AND NOT c.id=ANY(closure.path)
		), linked_contacts AS (
			SELECT DISTINCT household_id,contact_id FROM member_contact_closure
		), eligible_gifts AS (
			SELECT DISTINCT lc.household_id,g.id,g.tenant_id,g.currency,g.amount_minor
			FROM linked_contacts lc
			JOIN gifts g ON g.tenant_id=$1 AND g.contact_id=lc.contact_id
			WHERE g.status='recorded' AND g.kind NOT IN ('correction','pledge','soft_credit')
		), corrections AS (
			SELECT correction_of,
				COALESCE(sum(amount_minor) FILTER(WHERE status='refunded'),0) AS refunds,
				COALESCE(sum(amount_minor) FILTER(WHERE status='disputed'),0) AS disputes,
				COALESCE(sum(amount_minor) FILTER(WHERE data->>'direction'='reinstatement' AND status='recorded'),0) AS reinstatements
			FROM gifts WHERE tenant_id=$1 AND kind='correction'
			GROUP BY correction_of
		)
		SELECT eg.household_id AS "householdId",eg.currency,
			COALESCE(sum(eg.amount_minor),0)::text AS gross,
			COALESCE(sum(c.refunds),0)::text AS refunds,
			COALESCE(sum(c.disputes),0)::text AS disputes,
			COALESCE(sum(c.reinstatements),0)::text AS reinstatements,
			count(DISTINCT eg.id)::int AS "giftCount"
		FROM eligible_gifts eg LEFT JOIN corrections c ON c.correction_of=eg.id
		GROUP BY eg.household_id,eg.currency ORDER BY eg.household_id,eg.currency`,
		[tenantId, householdIds]
	);
	const summaries = new Map<string, HouseholdGivingTotal[]>();
	for (const row of result.rows) {
		const grossMinor = safeMinorUnits(row.gross, 'Household giving');
		const refundMinor = safeMinorUnits(row.refunds, 'Household refunds');
		const disputeMinor = safeMinorUnits(row.disputes, 'Household disputes');
		const reinstatedMinor = safeMinorUnits(row.reinstatements, 'Household reinstatements');
		const totals = summaries.get(row.householdId) || [];
		totals.push({
			currency: String(row.currency).trim(),
			grossMinor,
			refundMinor,
			disputeMinor,
			reinstatedMinor,
			netRecordedMinor: grossMinor - refundMinor - disputeMinor + reinstatedMinor,
			giftCount: Number(row.giftCount)
		});
		summaries.set(row.householdId, totals);
	}
	return summaries;
}
