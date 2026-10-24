import { describe, it, expect } from 'vitest';
import { ledgerReport, donorRetention, type GiftRow } from '../src/lib/reporting';
const gift = (id: string, amountMinor: number, extra: Partial<GiftRow> = {}): GiftRow => ({
	id,
	amountMinor,
	currency: 'USD',
	kind: 'one_time',
	status: 'recorded',
	contactId: 'donor-a',
	occurredAt: '2026-06-01T00:00:00Z',
	...extra
});
describe('Ledger reporting', () => {
	it('reconciles refunds, disputes and reinstatements without counting correction credits as gross', () => {
		const report = ledgerReport([
			gift('1', 10000),
			gift('2', 2000, { kind: 'correction', status: 'refunded' }),
			gift('3', 3000, { kind: 'correction', status: 'disputed' }),
			gift('4', 3000, { kind: 'correction', status: 'recorded', direction: 'reinstatement' }),
			gift('5', 5000, { kind: 'pledge', status: 'pledged' })
		]);
		expect(report).toMatchObject({
			grossMinor: 10000,
			refundMinor: 2000,
			disputeMinor: 3000,
			reinstatementMinor: 3000,
			netRecordedMinor: 8000,
			pledgedMinor: 5000,
			giftCount: 1,
			donorCount: 1
		});
		expect(report.eventIds).toHaveLength(5);
	});
	it('refuses to add different currencies', () => {
		expect(() => ledgerReport([gift('1', 100), gift('2', 100, { currency: 'EUR' })])).toThrow(
			/single currency/
		);
		expect(
			ledgerReport([gift('1', 100), gift('2', 100, { currency: 'EUR' })], { currency: 'EUR' })
				.grossMinor
		).toBe(100);
	});
	it('date and campaign filters include only qualifying ledger events', () => {
		expect(
			ledgerReport([gift('1', 100, { campaignId: 'a' }), gift('2', 200, { campaignId: 'b' })], {
				from: '2026-01-01',
				to: '2026-12-31',
				campaignId: 'a'
			}).eventIds
		).toEqual(['1']);
	});
	it('reports no retention rate for an absent prior cohort', () => {
		expect(donorRetention([gift('1', 100)], 2026).retentionRate).toBeNull();
		const cohort = donorRetention(
			[
				gift('1', 100, { occurredAt: '2025-01-01' }),
				gift('2', 200),
				gift('3', 100, { contactId: 'donor-b' })
			],
			2026
		);
		expect(cohort).toMatchObject({ retentionRate: 1, retainedDonors: 1, newDonors: 1 });
	});
});
