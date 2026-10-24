import { describe, it, expect } from 'vitest';
import { insightReport, type GiftRow } from '../src/lib/reporting';
const gift = (
	id: string,
	contactId: string,
	amountMinor: number,
	extra: Partial<GiftRow> = {}
): GiftRow => ({
	id,
	contactId,
	amountMinor,
	currency: 'USD',
	kind: 'one_time',
	status: 'recorded',
	occurredAt: '2026-06-01',
	...extra
});
describe('Insight snapshots', () => {
	it('reconciles recorded giving and explicit fees while separating annual commitments and pipelines', () => {
		const r = insightReport(
			{
				gifts: [
					gift('1', 'a', 12000),
					gift('2', 'a', 2000, { kind: 'correction', status: 'refunded' }),
					gift('3', 'b', 6000)
				],
				details: [{ giftId: '1', feeMinor: 300, settledMinor: 11700 }],
				subscriptions: [
					{ id: 's', amountMinor: 12000, currency: 'USD', frequency: 'annual', status: 'active' }
				],
				pledges: [{ amountMinor: 9000, currency: 'USD', status: 'open' }],
				proposals: [{ askMinor: 40000, currency: 'USD', stage: 'negotiation' }]
			},
			{ currency: 'USD', campaignCostMinor: 1000 }
		);
		expect(r.ledger.netRecordedMinor).toBe(16000);
		expect(r.netAfterKnownFeesMinor).toBe(15700);
		expect(r.feeCoverage).toEqual({ giftsWithFeeData: 1, originalGifts: 2 });
		expect(r.recurring?.mrrEquivalentMinor).toBe(1000);
		expect(r.pledgePipelineMinor).toBe(9000);
		expect(r.majorGiftPipelineMinor).toBe(40000);
		expect(r.campaignRoi).toBe(14.7);
	});
	it('keeps cohort origin before date filter, isolates owner/fund and currencies', () => {
		const r = insightReport(
			{
				gifts: [
					gift('1', 'a', 100, { occurredAt: '2025-01-01', fundId: 'fund' }),
					gift('2', 'a', 200, { fundId: 'fund' }),
					gift('3', 'b', 900, { fundId: 'other' }),
					gift('4', 'b', 900, { currency: 'EUR' })
				],
				contacts: [
					{ id: 'a', ownerId: 'o' },
					{ id: 'b', ownerId: 'x' }
				]
			},
			{ from: '2026-01-01', currency: 'USD', ownerId: 'o', fundId: 'fund' }
		);
		expect(r.ledger.grossMinor).toBe(200);
		expect(r.newDonors).toBe(0);
		expect(r.cohorts).toEqual([{ month: '2025-01', donors: 1, activeInSelectedPeriod: 1 }]);
		expect(r.byMonth[0].netRecordedMinor).toBe(200);
	});
	it('applies supported filters to associated pipelines and marks incompatible panels unavailable', () => {
		const r = insightReport(
			{
				gifts: [
					gift('a1', 'a', 1000, { campaignId: 'c', fundId: 'f' }),
					gift('a2', 'a', 3000, { campaignId: 'other', fundId: 'f' }),
					gift('b1', 'b', 9000, { campaignId: 'c', fundId: 'f' })
				],
				contacts: [
					{ id: 'a', ownerId: 'o' },
					{ id: 'b', ownerId: 'x' }
				],
				subscriptions: [
					{
						id: 's1',
						contactId: 'a',
						campaignId: 'c',
						fundId: 'f',
						amountMinor: 1200,
						currency: 'USD',
						frequency: 'monthly',
						status: 'active'
					},
					{
						id: 's2',
						contactId: 'b',
						campaignId: 'c',
						fundId: 'f',
						amountMinor: 7000,
						currency: 'USD',
						frequency: 'monthly',
						status: 'active'
					}
				],
				pledges: [
					{ contactId: 'a', campaignId: 'c', amountMinor: 5000, currency: 'USD', status: 'open' },
					{ contactId: 'b', campaignId: 'c', amountMinor: 9000, currency: 'USD', status: 'open' }
				],
				proposals: [
					{ contactId: 'a', ownerId: 'o', askMinor: 25000, currency: 'USD', stage: 'submitted' },
					{ contactId: 'b', ownerId: 'x', askMinor: 90000, currency: 'USD', stage: 'submitted' }
				]
			},
			{ currency: 'USD', campaignId: 'c', ownerId: 'o' }
		);
		expect(r.ledger.grossMinor).toBe(1000);
		expect(r.recurring?.mrrEquivalentMinor).toBe(1200);
		expect(r.pledgePipelineMinor).toBe(5000);
		expect(r.majorGiftPipelineMinor).toBeNull();
		expect(r.excludedMetrics).toContain('Major-gift proposal pipeline');
		expect(r.excludedMetrics).toContain('Prospect funnel');
		expect(r.prospectFunnel).toBeNull();
		const byFund = insightReport(
			{
				gifts: [gift('f', 'a', 1000, { fundId: 'f' })],
				contacts: [{ id: 'a', ownerId: 'o' }],
				subscriptions: [
					{
						id: 'sf',
						contactId: 'a',
						fundId: 'f',
						amountMinor: 1200,
						currency: 'USD',
						frequency: 'monthly',
						status: 'active'
					}
				],
				pledges: [{ contactId: 'a', amountMinor: 5000, currency: 'USD', status: 'open' }]
			},
			{ currency: 'USD', fundId: 'f' }
		);
		expect(byFund.recurring?.mrrEquivalentMinor).toBe(1200);
		expect(byFund.pledgePipelineMinor).toBeNull();
		expect(byFund.excludedMetrics).toContain('Open pledge pipeline');
	});
	it('keeps lifetime value and UTC calendar-year retention independent of the date-range window', () => {
		const r = insightReport(
			{
				gifts: [
					gift('prior', 'a', 1000, { occurredAt: '2026-01-01T01:30:00+02:00' }),
					gift('current', 'a', 2000, { occurredAt: '2026-12-31T23:30:00Z' }),
					gift('another', 'b', 3000, { occurredAt: '2026-06-01T00:00:00Z' })
				]
			},
			{ currency: 'USD', from: '2026-12-31', to: '2026-12-31', year: 2026 }
		);
		expect(r.donorLifetimeValueMinor).toBe(3000);
		expect(r.retention).toMatchObject({
			year: 2026,
			priorDonors: 1,
			currentDonors: 2,
			retainedDonors: 1,
			retentionRate: 1
		});
		expect(r.recurring).toBeNull();
		expect(r.pledgePipelineMinor).toBeNull();
		expect(r.majorGiftPipelineMinor).toBeNull();
		expect(r.excludedMetrics).toContain('Current active recurring commitments');
	});
});
