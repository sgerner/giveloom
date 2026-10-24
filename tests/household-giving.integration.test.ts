import { afterAll, describe, expect, it } from 'vitest';
import { createOwnerAccount, getPool, mutatePostgres } from '../src/lib/server/database';
import { givingCommand } from '../src/lib/server/giving';
import {
	householdGivingSummaries,
	summarizeDemoHouseholdGiving
} from '../src/lib/server/household-giving';
import { GET as collectionsGet } from '../src/routes/api/v1/collections/[resource]/+server';

const enabled = !!process.env.DATABASE_URL && process.env.RUN_POSTGRES_MUTATION_TESTS === 'true';
afterAll(async () => {
	if (enabled) await getPool().end();
});

describe('household hard-credit giving summary', () => {
	it('follows merge chains and counts reinstatements without double-counting duplicate members', () => {
		const summary = summarizeDemoHouseholdGiving(
			[{ id: 'house', memberIds: ['member-c', 'member-c'] }],
			[
				{ id: 'member-a', mergedInto: 'member-b' },
				{ id: 'member-b', mergedInto: 'member-c' }
			],
			[
				{
					id: 'gift-a',
					contactId: 'member-a',
					amountMinor: 10000,
					currency: 'USD',
					kind: 'one_time',
					status: 'recorded'
				},
				{
					id: 'gift-b',
					contactId: 'member-b',
					amountMinor: 5000,
					currency: 'USD',
					kind: 'one_time',
					status: 'recorded'
				},
				{
					id: 'gift-c',
					contactId: 'member-c',
					amountMinor: 3000,
					currency: 'USD',
					kind: 'one_time',
					status: 'recorded'
				},
				{
					id: 'reinstatement',
					contactId: 'member-a',
					correctionOf: 'gift-a',
					amountMinor: 1000,
					currency: 'USD',
					kind: 'correction',
					status: 'recorded',
					direction: 'reinstatement'
				},
				{
					id: 'soft-credit',
					contactId: 'member-c',
					amountMinor: 8000,
					currency: 'USD',
					kind: 'soft_credit',
					status: 'recorded'
				}
			]
		);
		expect(summary.get('house')).toEqual([
			{
				currency: 'USD',
				grossMinor: 18000,
				refundMinor: 0,
				disputeMinor: 0,
				reinstatedMinor: 1000,
				netRecordedMinor: 19000,
				giftCount: 3
			}
		]);
	});

	it.skipIf(!enabled)(
		'aggregates exact currency totals across deduplicated and merged members with corrections',
		async () => {
			const slug = `household-giving-${crypto.randomUUID().slice(0, 8)}`;
			const account = await createOwnerAccount({
				email: `${slug}@example.test`,
				name: 'Household Owner',
				passwordHash: 'fixture',
				organizationName: 'Household giving tests',
				slug,
				sessionExpiresAt: new Date(Date.now() + 3_600_000),
				testOnlyVerifiedFixture: true
			});
			const session = { userId: account.userId, tenantSlug: slug, role: 'owner', demo: false };
			const primary = (await mutatePostgres(
				slug,
				account.userId,
				'contacts',
				{ name: 'Primary Member' },
				'create'
			)) as any;
			const merged = (await mutatePostgres(
				slug,
				account.userId,
				'contacts',
				{ name: 'Merged Member' },
				'create'
			)) as any;
			const household = (await mutatePostgres(
				slug,
				account.userId,
				'households',
				{ name: 'Shared household', memberIds: [primary.id, primary.id, merged.id] },
				'create'
			)) as any;
			const first = (await givingCommand(session, {
				action: 'record',
				requestKey: crypto.randomUUID(),
				contactId: primary.id,
				amountMinor: 10000,
				currency: 'USD',
				kind: 'one_time',
				method: 'check',
				feeMinor: 0,
				restricted: false,
				anonymous: false
			})) as any;
			const second = (await givingCommand(session, {
				action: 'record',
				requestKey: crypto.randomUUID(),
				contactId: merged.id,
				amountMinor: 5000,
				currency: 'EUR',
				kind: 'one_time',
				method: 'cash',
				feeMinor: 0,
				restricted: false,
				anonymous: false
			})) as any;
			await givingCommand(session, {
				action: 'correction',
				giftId: first.id,
				type: 'refund',
				amountMinor: 2000,
				reason: 'Household aggregate test refund',
				requestKey: crypto.randomUUID(),
				confirmed: true
			});
			await givingCommand(session, {
				action: 'soft_credit',
				giftId: first.id,
				contactId: merged.id,
				amountMinor: 7000,
				reason: 'Soft credit must not be added to hard-credit totals'
			});
			const client = await getPool().connect();
			let totals: Map<string, import('../src/lib/server/household-giving').HouseholdGivingTotal[]>;
			try {
				await client.query('BEGIN');
				await client.query("SELECT set_config('app.tenant_id',$1,true)", [account.tenantId]);
				await client.query(
					'UPDATE contacts SET merged_into=$3,archived_at=now() WHERE tenant_id=$1 AND id=$2',
					[account.tenantId, merged.id, primary.id]
				);
				await client.query(
					"UPDATE workspace_records SET data=jsonb_set(data,'{memberIds}',to_jsonb(ARRAY[$3::text,$2::text,$3::text])) WHERE tenant_id=$1 AND resource='households' AND id=$4",
					[account.tenantId, merged.id, primary.id, household.id]
				);
				await client.query('COMMIT');
				await client.query('BEGIN');
				await client.query("SELECT set_config('app.tenant_id',$1,true)", [account.tenantId]);
				totals = await householdGivingSummaries(client, account.tenantId, [household.id]);
				await client.query('COMMIT');
				expect(totals.get(household.id)).toEqual([
					{
						currency: 'EUR',
						grossMinor: 5000,
						refundMinor: 0,
						disputeMinor: 0,
						reinstatedMinor: 0,
						netRecordedMinor: 5000,
						giftCount: 1
					},
					{
						currency: 'USD',
						grossMinor: 10000,
						refundMinor: 2000,
						disputeMinor: 0,
						reinstatedMinor: 0,
						netRecordedMinor: 8000,
						giftCount: 1
					}
				]);
			} catch (error) {
				await client.query('ROLLBACK').catch(() => {});
				throw error;
			} finally {
				client.release();
			}
			const response = await collectionsGet({
				params: { resource: 'households' },
				url: new URL(`http://localhost/api/v1/collections/households?tenant=${slug}`),
				locals: { session }
			} as any);
			const directory = await response.json();
			expect(response.status).toBe(200);
			expect(directory.givingSummaryPolicy).toContain('soft credits are excluded');
			expect(
				directory.items.find((item: any) => item.id === household.id).hardCreditGivingByCurrency
			).toEqual(totals.get(household.id));
			expect(second.id).toBeTruthy();
		}
	);
});
