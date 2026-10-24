export type GiftRow = {
	id: string;
	contactId?: string;
	campaignId?: string;
	amountMinor: number;
	currency: string;
	status: string;
	kind: string;
	occurredAt?: string;
	createdAt?: string;
	direction?: string;
	[key: string]: unknown;
};
export type ReportFilter = {
	from?: string;
	to?: string;
	campaignId?: string;
	currency?: string;
	fundId?: string;
	ownerId?: string;
	segmentId?: string;
	year?: number;
};
export function ledgerReport(gifts: GiftRow[], filter: ReportFilter = {}) {
	const rows = gifts.filter(
		(g) =>
			(!filter.currency || g.currency === filter.currency) &&
			(!filter.campaignId || g.campaignId === filter.campaignId) &&
			(!filter.from || String(g.occurredAt || g.createdAt).slice(0, 10) >= filter.from) &&
			(!filter.to || String(g.occurredAt || g.createdAt).slice(0, 10) <= filter.to)
	);
	const currencies = [...new Set(rows.map((g) => g.currency))];
	if (currencies.length > 1)
		throw new Error('Choose a single currency. Currency totals are never silently converted.');
	let grossMinor = 0,
		refundMinor = 0,
		disputeMinor = 0,
		reinstatementMinor = 0,
		pledgedMinor = 0;
	const donors = new Set<string>();
	for (const gift of rows) {
		if (!Number.isSafeInteger(gift.amountMinor) || gift.amountMinor < 0)
			throw new Error('Ledger amounts must be nonnegative integer minor units.');
		if (gift.kind === 'pledge' || gift.status === 'pledged') {
			pledgedMinor += gift.amountMinor;
			continue;
		}
		if (gift.kind === 'correction') {
			if (gift.status === 'refunded') refundMinor += gift.amountMinor;
			else if (gift.status === 'disputed') disputeMinor += gift.amountMinor;
			else if (gift.direction === 'reinstatement' && gift.status === 'recorded')
				reinstatementMinor += gift.amountMinor;
			continue;
		}
		if (gift.status === 'recorded') {
			grossMinor += gift.amountMinor;
			if (gift.contactId) donors.add(gift.contactId);
		}
	}
	return {
		snapshotAt: new Date().toISOString(),
		currency: currencies[0] || filter.currency || 'USD',
		grossMinor,
		refundMinor,
		disputeMinor,
		reinstatementMinor,
		netRecordedMinor: grossMinor - refundMinor - disputeMinor + reinstatementMinor,
		pledgedMinor,
		donorCount: donors.size,
		giftCount: rows.filter(
			(g) => g.status === 'recorded' && !['correction', 'pledge'].includes(g.kind)
		).length,
		eventIds: rows.map((g) => g.id),
		rows,
		definition:
			'Gross is recorded original gifts. Net deducts recorded refunds/disputes and adds dispute reinstatements. Pledges, soft credits, household attribution, fees, settlements and currency conversion are excluded from net.'
	};
}
export function donorRetention(gifts: GiftRow[], currentYear: number) {
	const paid = gifts.filter(
		(g) => g.status === 'recorded' && !['correction', 'pledge'].includes(g.kind) && g.contactId
	);
	const previous = new Set(
		paid
			.filter(
				(g) => new Date(String(g.occurredAt || g.createdAt)).getUTCFullYear() === currentYear - 1
			)
			.map((g) => g.contactId!)
	);
	const current = new Set(
		paid
			.filter((g) => new Date(String(g.occurredAt || g.createdAt)).getUTCFullYear() === currentYear)
			.map((g) => g.contactId!)
	);
	const retained = [...previous].filter((id) => current.has(id)).length;
	return {
		year: currentYear,
		priorDonors: previous.size,
		currentDonors: current.size,
		retainedDonors: retained,
		retentionRate: previous.size ? retained / previous.size : null,
		newDonors: [...current].filter((id) => !previous.has(id)).length,
		definition:
			'UTC calendar-year hard-credit donor retention: the denominator is identified donors with a recorded original gift in the previous UTC calendar year; retained donors also gave in the selected UTC year. Anonymous/unassigned gifts and corrections are excluded. No prior-year cohort produces no rate.'
	};
}

export type InsightInput = {
	gifts: GiftRow[];
	details?: { giftId: string; feeMinor: number; settledMinor?: number | null }[];
	contacts?: { id: string; ownerId?: string; stage?: string }[];
	subscriptions?: {
		id: string;
		contactId?: string;
		campaignId?: string;
		fundId?: string;
		amountMinor: number;
		currency: string;
		frequency: string;
		status: string;
	}[];
	pledges?: {
		contactId?: string;
		campaignId?: string;
		amountMinor: number;
		currency: string;
		status: string;
	}[];
	proposals?: {
		contactId?: string;
		ownerId?: string;
		askMinor: number;
		currency: string;
		stage: string;
	}[];
	prospects?: { stage: string }[];
	introductions?: { status: string }[];
	email?: { status: string; count: number }[];
};
export function insightReport(
	input: InsightInput,
	filter: ReportFilter & {
		fundId?: string;
		ownerId?: string;
		segmentIds?: string[];
		campaignCostMinor?: number;
	} = {}
) {
	const allowedContacts = new Set(
		(input.contacts || [])
			.filter((c) => !filter.ownerId || c.ownerId === filter.ownerId)
			.map((c) => c.id)
	);
	const gifts = input.gifts.filter(
		(g) =>
			(!filter.fundId || g.fundId === filter.fundId) &&
			(!filter.ownerId || (!!g.contactId && allowedContacts.has(g.contactId))) &&
			(!filter.segmentIds || (!!g.contactId && filter.segmentIds.includes(g.contactId)))
	);
	const ledger = ledgerReport(gifts, filter);
	const lifetimeGifts = gifts.filter(
		(g) =>
			(!filter.currency || g.currency === filter.currency) &&
			(!filter.campaignId || g.campaignId === filter.campaignId)
	);
	const inAudience = (contactId?: string) =>
		!!contactId &&
		(!filter.ownerId || allowedContacts.has(contactId)) &&
		(!filter.segmentIds || filter.segmentIds.includes(contactId));
	const selected = new Set(ledger.rows.map((g) => g.id));
	const details = (input.details || []).filter((d) => selected.has(d.giftId));
	const feesMinor = details.reduce((n, d) => n + d.feeMinor, 0);
	const settlementKnown = details.filter(
		(d) => d.settledMinor !== null && d.settledMinor !== undefined
	);
	const donorTotals = new Map<string, number>();
	const donorDates = new Map<string, string[]>();
	for (const g of ledger.rows) {
		if (!g.contactId || g.kind === 'pledge') continue;
		const sign =
			g.kind === 'correction'
				? g.direction === 'reinstatement'
					? 1
					: -1
				: g.status === 'recorded'
					? 1
					: 0;
		donorTotals.set(g.contactId, (donorTotals.get(g.contactId) || 0) + sign * g.amountMinor);
		if (g.kind !== 'correction' && g.status === 'recorded') {
			const dates = donorDates.get(g.contactId) || [];
			dates.push(String(g.occurredAt || g.createdAt).slice(0, 7));
			donorDates.set(g.contactId, dates);
		}
	}
	donorTotals.clear();
	for (const g of lifetimeGifts) {
		if (!g.contactId || g.currency !== ledger.currency || g.kind === 'pledge') continue;
		const sign =
			g.kind === 'correction'
				? g.direction === 'reinstatement'
					? 1
					: -1
				: g.status === 'recorded'
					? 1
					: 0;
		donorTotals.set(g.contactId, (donorTotals.get(g.contactId) || 0) + sign * g.amountMinor);
	}
	const lifetimeCounts = new Map<string, number>();
	for (const g of lifetimeGifts) {
		if (
			g.contactId &&
			g.currency === ledger.currency &&
			g.kind !== 'correction' &&
			g.kind !== 'pledge' &&
			g.status === 'recorded'
		)
			lifetimeCounts.set(g.contactId, (lifetimeCounts.get(g.contactId) || 0) + 1);
	}
	const cohorts = new Map<string, Set<string>>();
	const first = new Map<string, string>();
	for (const g of lifetimeGifts) {
		if (
			!g.contactId ||
			g.kind === 'correction' ||
			g.kind === 'pledge' ||
			g.status !== 'recorded' ||
			g.currency !== ledger.currency
		)
			continue;
		const month = String(g.occurredAt || g.createdAt).slice(0, 10);
		if (!first.has(g.contactId) || month < first.get(g.contactId)!) first.set(g.contactId, month);
	}
	for (const [id, date] of first) {
		const month = date.slice(0, 7);
		const group = cohorts.get(month) || new Set<string>();
		group.add(id);
		cohorts.set(month, group);
	}
	const byMonth = new Map<string, GiftRow[]>(),
		byCampaign = new Map<string, GiftRow[]>(),
		bySource = new Map<string, GiftRow[]>();
	for (const g of ledger.rows) {
		for (const [map, key] of [
			[byMonth, String(g.occurredAt || g.createdAt).slice(0, 7)],
			[byCampaign, String(g.campaignId || 'unassigned')],
			[
				bySource,
				String(g.kind === 'correction' ? 'corrections' : g.source || g.paymentMethod || g.kind)
			]
		] as [Map<string, GiftRow[]>, string][]) {
			const rows = map.get(key) || [];
			rows.push(g);
			map.set(key, rows);
		}
	}
	const group = (map: Map<string, GiftRow[]>) =>
		[...map]
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([key, rows]) => ({
				key,
				...ledgerReport(rows, { currency: ledger.currency }),
				rows: undefined
			}));
	const subscriptions = (input.subscriptions || []).filter(
		(s) =>
			s.currency === ledger.currency &&
			(!filter.campaignId || s.campaignId === filter.campaignId) &&
			(!filter.fundId || s.fundId === filter.fundId) &&
			(!filter.ownerId || inAudience(s.contactId)) &&
			(!filter.segmentIds || inAudience(s.contactId))
	);
	const active = subscriptions.filter((s) => s.status === 'active');
	const ended = subscriptions.filter((s) => s.status === 'ended');
	const countStages = (rows: { stage?: string; status?: string }[]) =>
		Object.fromEntries(
			[...new Set(rows.map((x) => x.stage || x.status || 'unknown'))]
				.sort()
				.map((stage) => [
					stage,
					rows.filter((x) => (x.stage || x.status || 'unknown') === stage).length
				])
		);
	const matchedPledges = (input.pledges || []).filter(
		(p) =>
			p.currency === ledger.currency &&
			(!filter.campaignId || p.campaignId === filter.campaignId) &&
			(!filter.ownerId || inAudience(p.contactId)) &&
			(!filter.segmentIds || inAudience(p.contactId)) &&
			['open', 'active'].includes(p.status)
	);
	const matchedProposals = (input.proposals || []).filter(
		(p) =>
			p.currency === ledger.currency &&
			(!filter.ownerId || p.ownerId === filter.ownerId) &&
			(!filter.segmentIds || inAudience(p.contactId)) &&
			!['won', 'lost'].includes(p.stage)
	);
	const pipeline = matchedProposals.reduce((n, p) => n + p.askMinor, 0);
	const hasPeriod = !!filter.from || !!filter.to;
	const hasAudienceFilter = !!(
		filter.campaignId ||
		filter.fundId ||
		filter.ownerId ||
		filter.segmentIds
	);
	const excludedMetrics = [
		...(hasPeriod ? ['Current active recurring commitments'] : []),
		...(hasPeriod || !!filter.fundId ? ['Open pledge pipeline'] : []),
		...(hasPeriod || !!filter.fundId || !!filter.campaignId
			? ['Major-gift proposal pipeline']
			: []),
		...(hasAudienceFilter || hasPeriod
			? ['Prospect funnel', 'Introduction outcomes', 'Email delivery snapshot', 'Board stewardship']
			: [])
	];
	const recurringExcluded = hasPeriod;
	const pledgeExcluded = hasPeriod || !!filter.fundId;
	const proposalExcluded = hasPeriod || !!filter.fundId || !!filter.campaignId;
	const contextExcluded = hasAudienceFilter || hasPeriod;
	const retentionYear = filter.year || new Date().getUTCFullYear();
	return {
		snapshotAt: ledger.snapshotAt,
		currency: ledger.currency,
		filters: filter,
		ledger: { ...ledger, rows: undefined },
		feesMinor,
		netAfterKnownFeesMinor: ledger.netRecordedMinor - feesMinor,
		feeCoverage: { giftsWithFeeData: details.length, originalGifts: ledger.giftCount },
		settledMinor: settlementKnown.reduce((n, d) => n + Number(d.settledMinor), 0),
		settlementCoverage: settlementKnown.length,
		averageGiftMinor: ledger.giftCount ? ledger.grossMinor / ledger.giftCount : null,
		repeatDonors: [...donorDates.keys()].filter((id) => (lifetimeCounts.get(id) || 0) > 1).length,
		newDonors: [...first].filter(
			([id, month]) => donorDates.has(id) && (!filter.from || month >= filter.from)
		).length,
		donorLifetimeValueMinor: donorTotals.size
			? [...donorTotals.values()].reduce((n, x) => n + x, 0) / donorTotals.size
			: null,
		retention: donorRetention(lifetimeGifts, retentionYear),
		cohorts: [...cohorts]
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([month, ids]) => ({
				month,
				donors: ids.size,
				activeInSelectedPeriod: [...ids].filter((id) => donorDates.has(id)).length
			})),
		byMonth: group(byMonth),
		byCampaign: group(byCampaign),
		bySource: group(bySource),
		recurring: recurringExcluded
			? null
			: {
					active: active.length,
					ended: ended.length,
					mrrEquivalentMinor: active.reduce(
						(n, s) => n + s.amountMinor / (s.frequency === 'annual' ? 12 : 1),
						0
					),
					endedShare: subscriptions.length ? ended.length / subscriptions.length : null,
					definition:
						'MRR equivalent uses active subscription commitments; annual amounts divided by twelve. Ended share is a current-state share, not period churn.'
				},
		pledgePipelineMinor: pledgeExcluded
			? null
			: matchedPledges.reduce((n, p) => n + p.amountMinor, 0),
		majorGiftPipelineMinor: proposalExcluded ? null : pipeline,
		prospectFunnel: contextExcluded ? null : countStages(input.prospects || []),
		introductionOutcomes: contextExcluded ? null : countStages(input.introductions || []),
		emailDelivery: contextExcluded ? null : input.email || [],
		boardEngagement: contextExcluded ? null : undefined,
		excludedMetrics,
		campaignRoi:
			filter.campaignCostMinor && filter.campaignCostMinor > 0
				? (ledger.netRecordedMinor - feesMinor - filter.campaignCostMinor) /
					filter.campaignCostMinor
				: null,
		definitions: {
			donorLifetimeValue:
				'Average lifetime recorded net giving per identified donor across available history in the selected currency, campaign, fund and audience; date filters do not truncate lifetime history. No inferred future value.',
			cohorts:
				'First recorded gift calendar month; active count means a recorded original gift in the selected period.',
			retention:
				'UTC calendar-year hard-credit donor retention: the denominator is identified donors with a recorded original gift in the prior UTC calendar year; retained donors also gave in the selected UTC year. Date-range filters do not change this annual cohort. Currency, campaign, fund and contact-audience filters do apply.',
			fees: 'Only explicitly captured fees; missing fees are excluded and coverage is shown.',
			campaignRoi:
				'(Recorded net giving − known fees − user supplied campaign cost) / campaign cost. No estimated costs.',
			privacy:
				'Hard credits, canonical merged identity; no soft-credit or household double counting.',
			pipeline: 'Open pledge commitments and proposals, shown separately from received gifts.'
		}
	};
}
