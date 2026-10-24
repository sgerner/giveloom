import { afterAll, describe, expect, it } from 'vitest';
import { createOwnerAccount, getPool, mutatePostgres } from '../src/lib/server/database';
import {
	givingCommand,
	givingStatement,
	renderGivingStatementHtml
} from '../src/lib/server/giving';

const enabled = !!process.env.DATABASE_URL && process.env.RUN_POSTGRES_MUTATION_TESTS === 'true';
afterAll(async () => {
	if (enabled) await getPool().end();
});

async function fixture(prefix: string) {
	const suffix = crypto.randomUUID().slice(0, 8);
	const slug = `${prefix}-${suffix}`;
	const account = await createOwnerAccount({
		email: `${slug}@example.test`,
		name: 'Finance Owner',
		passwordHash: 'fixture',
		organizationName: 'Giving Test Organization',
		slug,
		sessionExpiresAt: new Date(Date.now() + 3_600_000),
		testOnlyVerifiedFixture: true
	});
	const session = { userId: account.userId, tenantSlug: slug, role: 'owner', demo: false };
	const donor = (await mutatePostgres(
		slug,
		account.userId,
		'contacts',
		{ name: 'Donor <One>', email: `donor-${slug}@example.test` },
		'create'
	)) as { id: string };
	const credited = (await mutatePostgres(
		slug,
		account.userId,
		'contacts',
		{ name: 'Credited Supporter', email: `credited-${slug}@example.test` },
		'create'
	)) as { id: string };
	return { session, donor, credited };
}

function gift(contactId: string, requestKey = crypto.randomUUID()) {
	return {
		action: 'record',
		requestKey,
		contactId,
		amountMinor: 10_000,
		currency: 'USD',
		occurredAt: '2026-04-02T12:00:00.000Z',
		method: 'check',
		feeMinor: 100,
		checkReference: 'check-1'
	};
}

it('renders printable statements with escaped donor and organization values', () => {
	const html = renderGivingStatementHtml({
		organization: '<script>alert(1)</script>',
		donorName: 'A & B',
		year: 2026,
		currencies: [
			{
				currency: 'USD',
				grossMinor: 1000,
				refundMinor: 0,
				disputeMinor: 0,
				reinstatedMinor: 0,
				netRecordedMinor: 1000
			}
		],
		disclaimer: 'Not tax advice.',
		preparedAt: 'October 23, 2026'
	});
	expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
	expect(html).toContain('A &amp; B');
	expect(html).not.toContain('<script>alert(1)</script>');
	expect(html).toContain('window.print()');
});

describe('giving ledger database behavior', () => {
	it.skipIf(!enabled)(
		'replays an identical gift idempotently and rejects reuse of its key for changed details',
		async () => {
			const a = await fixture('giving-idempotency');
			const command = gift(a.donor.id);
			const first = await givingCommand(a.session, command);
			expect(first).toMatchObject({ recorded: true });
			expect(await givingCommand(a.session, command)).toMatchObject({
				id: first.id,
				replayed: true
			});
			await expect(
				givingCommand(a.session, { ...command, amountMinor: 10_001 })
			).rejects.toMatchObject({ status: 409 });
			const snapshot = await import('../src/lib/server/giving').then(({ givingSnapshot }) =>
				givingSnapshot(a.session, a.donor.id)
			);
			expect(snapshot.gifts).toHaveLength(1);
		}
	);

	it.skipIf(!enabled)(
		'keeps corrections immutable, capped, idempotent, and visible in a secure annual statement',
		async () => {
			const a = await fixture('giving-corrections');
			const original = await givingCommand(a.session, gift(a.donor.id));
			const correction = {
				action: 'correction',
				giftId: original.id,
				type: 'refund',
				amountMinor: 2_000,
				reason: 'Partial check refund',
				requestKey: crypto.randomUUID(),
				confirmed: true
			};
			const refund = await givingCommand(a.session, correction);
			expect(await givingCommand(a.session, correction)).toMatchObject({
				id: refund.id,
				replayed: true
			});
			await expect(
				givingCommand(a.session, { ...correction, amountMinor: 2_100 })
			).rejects.toMatchObject({ status: 409 });
			await givingCommand(a.session, {
				...correction,
				type: 'dispute',
				amountMinor: 7_000,
				requestKey: crypto.randomUUID()
			});
			await expect(
				givingCommand(a.session, {
					...correction,
					amountMinor: 2_000,
					requestKey: crypto.randomUUID()
				})
			).rejects.toMatchObject({ status: 409 });
			const statement = await givingStatement(a.session, a.donor.id, 2026);
			expect(statement.currencies).toEqual([
				{
					currency: 'USD',
					grossMinor: 10_000,
					refundMinor: 2_000,
					disputeMinor: 7_000,
					reinstatedMinor: 0,
					netRecordedMinor: 1_000
				}
			]);
			expect(statement.disclaimer).toContain('not tax or legal advice');
			await expect(
				givingStatement({ ...a.session, role: 'fundraiser' }, a.donor.id, 2026)
			).rejects.toMatchObject({ status: 403 });
			await expect(givingStatement(a.session, crypto.randomUUID(), 2026)).rejects.toMatchObject({
				status: 404
			});
		}
	);

	it.skipIf(!enabled)(
		'records soft credits, pledge installments, and matching gifts without inflating hard-gift totals',
		async () => {
			const a = await fixture('giving-attribution');
			const b = await fixture('giving-other-tenant');
			const hardGift = await givingCommand(a.session, gift(a.donor.id));
			const attributed = await givingCommand(a.session, {
				action: 'soft_credit',
				giftId: hardGift.id,
				contactId: a.credited.id,
				amountMinor: 10_000,
				reason: 'Introduced the donor'
			});
			expect(attributed.id).toBeTruthy();
			await expect(
				givingCommand(a.session, {
					action: 'soft_credit',
					giftId: hardGift.id,
					contactId: a.credited.id,
					amountMinor: 10_000,
					reason: 'Duplicate attribution'
				})
			).rejects.toMatchObject({ status: 409 });
			const pledge = await givingCommand(a.session, {
				action: 'pledge',
				contactId: a.donor.id,
				amountMinor: 5_000,
				currency: 'USD',
				dueAt: '2026-12-31T12:00:00.000Z',
				description: 'Winter commitment',
				installments: [{ amountMinor: 5_000, dueAt: '2026-12-31T12:00:00.000Z' }]
			});
			const installmentSnapshot = await import('../src/lib/server/giving').then(
				({ givingSnapshot }) => givingSnapshot(a.session, a.donor.id)
			);
			const installment = installmentSnapshot.installments.find(
				(item: any) => item.pledgeId === pledge.id
			);
			const installmentGift = await givingCommand(a.session, {
				...gift(a.donor.id),
				amountMinor: 5_000
			});
			await givingCommand(a.session, {
				action: 'fulfill_installment',
				installmentId: installment.id,
				giftId: installmentGift.id
			});
			await expect(
				givingCommand(a.session, {
					action: 'fulfill_installment',
					installmentId: installment.id,
					giftId: installmentGift.id
				})
			).rejects.toMatchObject({ status: 409 });
			const match = await givingCommand(a.session, {
				action: 'matching',
				giftId: hardGift.id,
				organization: 'Community Employer',
				amountMinor: 10_000
			});
			await expect(
				givingCommand(a.session, {
					action: 'match_received',
					matchId: match.id,
					matchedGiftId: crypto.randomUUID()
				})
			).rejects.toMatchObject({ status: 404 });
			await expect(
				givingCommand(b.session, {
					action: 'soft_credit',
					giftId: hardGift.id,
					contactId: b.donor.id,
					amountMinor: 1_000,
					reason: 'Cross-tenant attempt'
				})
			).rejects.toMatchObject({ status: 404 });
			await expect(givingStatement(a.session, b.donor.id, 2026)).rejects.toMatchObject({
				status: 404
			});
			const statement = await givingStatement(a.session, a.donor.id, 2026);
			expect(statement.currencies[0].grossMinor).toBe(15_000);
			expect(statement.currencies[0].netRecordedMinor).toBe(15_000);
			expect(statement.currencies).toHaveLength(1);
		}
	);
});
