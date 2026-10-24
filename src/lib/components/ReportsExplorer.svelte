<script lang="ts">
	import { formatMoney, majorToMinor } from '$lib/money';
	import ReportSchedules from './ReportSchedules.svelte';
	import { onMount } from 'svelte';
	let {
		tenant,
		contacts = [],
		campaigns = []
	} = $props<{ tenant: string; contacts?: any[]; campaigns?: any[] }>();
	const allWidgets = [
		'summary',
		'monthly',
		'campaign',
		'source',
		'cohorts',
		'pipeline',
		'dictionary'
	];
	let widgets = $state<string[]>([...allWidgets]),
		preferenceMessage = $state(''),
		segments = $state<any[]>([]),
		segmentId = $state(''),
		owners = $state<any[]>([]);
	let retentionYear = $state(String(new Date().getUTCFullYear()));
	async function saveWidgets() {
		const r = await fetch('/api/v1/preferences', {
			method: 'PATCH',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ reportWidgets: widgets })
		});
		preferenceMessage = r.ok ? 'Report layout saved.' : 'Layout could not be saved.';
	}
	let report = $state<any>(null),
		error = $state(''),
		busy = $state(false),
		from = $state(''),
		to = $state(''),
		currency = $state('USD'),
		campaignId = $state(''),
		fundId = $state(''),
		funds = $state<any[]>([]),
		ownerId = $state(''),
		cost = $state('');
	function query() {
		return new URLSearchParams(
			Object.fromEntries(
				Object.entries({
					from,
					to,
					currency,
					campaignId,
					fundId,
					ownerId,
					segmentId,
					year: retentionYear,
					campaignCostMinor: cost ? String(majorToMinor(cost, currency)) : ''
				}).filter(([, v]) => v)
			)
		);
	}
	async function load() {
		busy = true;
		error = '';
		try {
			const r = await fetch(`/api/v1/reports/insights?${query()}`);
			const data = await r.json();
			if (!r.ok) throw new Error(data.error || 'Report unavailable.');
			report = data;
		} catch (e) {
			error = e instanceof Error ? e.message : 'Report unavailable.';
		} finally {
			busy = false;
		}
	}
	const money = (n: number | null) =>
		n === null ? '—' : formatMoney(Math.round(n), report?.currency || currency);
	function print() {
		window.print();
	}
	onMount(() => {
		void load();
		void fetch('/api/v1/preferences')
			.then((r) => r.json())
			.then((d) => (widgets = d.preferences?.reportWidgets || allWidgets))
			.catch(() => {});
		void fetch(`/api/v1/workspace?compact=true&tenant=${tenant}`)
			.then((r) => r.json())
			.then((d) => (segments = d.segments || []))
			.catch(() => {});
		void fetch('/api/v1/tasks/assignees')
			.then((r) => r.json())
			.then((d) => (owners = d.assignees || []))
			.catch(() => {});
		void fetch('/api/v1/campaigns/funds')
			.then((r) => r.json())
			.then((d) => (funds = d.funds || []))
			.catch(() => {});
	});
</script>

<section class="reports">
	<header>
		<span class="eyebrow">CLEAR NUMBERS · THOUGHTFUL DECISIONS</span>
		<h1>Understand your impact<span class="heading-dot">.</span></h1>
		<p>Recorded money, commitments, and engagement, with definitions and coverage.</p>
	</header>
	{#if error}<p class="banner error" role="alert">{error}</p>{/if}
	<form
		class="filters"
		onsubmit={(e) => {
			e.preventDefault();
			load();
		}}
	>
		<label>From<input type="date" bind:value={from} /></label><label
			>To<input type="date" bind:value={to} /></label
		><label>Currency<input maxlength="3" bind:value={currency} /></label><label
			>Retention year (UTC)<input
				type="number"
				min="1900"
				max="2200"
				bind:value={retentionYear}
			/></label
		><label
			>Campaign<select bind:value={campaignId}
				><option value="">All campaigns</option>{#each campaigns as c}<option value={c.id}
						>{c.name}</option
					>{/each}</select
			></label
		><label
			>Fund<select bind:value={fundId}
				><option value="">All funds</option>{#each funds as f}<option value={f.id}>{f.name}</option
					>{/each}</select
			></label
		><label
			>Assigned officer<select bind:value={ownerId}
				><option value="">All officers</option>{#each owners as owner}<option value={owner.id}
						>{owner.name}</option
					>{/each}</select
			></label
		><label
			>Segment<select bind:value={segmentId}
				><option value="">All people</option>{#each segments as segment}<option value={segment.id}
						>{segment.name}</option
					>{/each}</select
			></label
		><label
			>Campaign cost (optional)<input type="number" min="0" step=".01" bind:value={cost} /></label
		><button class="primary" disabled={busy}>{busy ? 'Calculating…' : 'Run report'}</button>
	</form>
	<details>
		<summary>Customize report layout</summary>
		<div class="filters">
			{#each allWidgets as widget}<label
					><input
						type="checkbox"
						checked={widgets.includes(widget)}
						onchange={(e) =>
							(widgets = e.currentTarget.checked
								? [...widgets, widget]
								: widgets.filter((w) => w !== widget))}
					/>{widget}</label
				>{/each}<button onclick={saveWidgets}>Save report layout</button>
		</div>
		{#if preferenceMessage}<p role="status">{preferenceMessage}</p>{/if}
	</details>
	{#if report}<p class="muted">
			Snapshot {new Date(report.snapshotAt).toLocaleString()} · {report.currency} only
		</p>
		{#if widgets.includes('summary')}<div class="metrics">
				{#each [['Gross recorded gifts', report.ledger.grossMinor, ''], ['Net recorded giving', report.ledger.netRecordedMinor, ''], ['Known fees', report.feesMinor, ''], ['Net after known fees', report.netAfterKnownFeesMinor, ''], ['Average gift', report.averageGiftMinor, ''], ['Average lifetime net giving per identified donor', report.donorLifetimeValueMinor, ''], ['Active recurring monthly equivalent', report.recurring?.mrrEquivalentMinor, 'Current active recurring commitments'], ['Open pledge commitments', report.pledgePipelineMinor, 'Open pledge pipeline'], ['Major-gift proposal pipeline', report.majorGiftPipelineMinor, 'Major-gift proposal pipeline']] as [label, value, exclusion]}<article
					>
						<span>{label}</span><strong
							>{exclusion && report.excludedMetrics.includes(exclusion)
								? 'Not shown for these filters'
								: money(value as number | null)}</strong
						>
					</article>{/each}
				<article>
					<span>Donor retention · UTC calendar year {report.retention.year}</span><strong
						>{report.retention.retentionRate == null
							? 'No prior-year cohort'
							: `${(report.retention.retentionRate * 100).toFixed(1)}%`}</strong
					>
					<p>
						{report.retention.retainedDonors} retained from {report.retention.priorDonors} prior-year
						donors · {report.retention.currentDonors} gave in {report.retention.year}
					</p>
				</article>
			</div>{/if}
		{#if report.excludedMetrics?.length}<p class="banner neutral" role="status">
				Panels excluded because their records cannot honor the selected filters: {report.excludedMetrics.join(
					', '
				)}.
			</p>{/if}
		<p>
			{report.ledger.giftCount} original gifts · {report.ledger.donorCount} identified donors · {report.newDonors}
			first-time donors in selected period · {report.repeatDonors} repeat donors
		</p>
		<p>
			Fee coverage: {report.feeCoverage.giftsWithFeeData}/{report.feeCoverage.originalGifts} original
			gifts. Settlement records: {report.settlementCoverage}. Campaign ROI: {report.campaignRoi ===
			null
				? 'Enter a campaign cost'
				: `${(report.campaignRoi * 100).toFixed(1)}%`}.
		</p>
		<p>
			Recorded recurring churn ({report.recurringChurn?.from}–{report.recurringChurn?.to}): {report
				.recurringChurn?.rate == null
				? 'Insufficient starting-cohort history'
				: `${(report.recurringChurn.rate * 100).toFixed(1)}%`} · {report.recurringChurn?.churned ||
				0} ended from {report.recurringChurn?.activeAtStart || 0} active at period start. Status-history
			coverage: {report.recurringChurn?.historyCoverage || 0} subscriptions.
		</p>
		<p class="muted">{report.recurringChurn?.definition}</p>
		<div class="actions">
			<a href={`/api/v1/reports/giving?tenant=${tenant}&format=csv&${query()}`}
				>Finance reconciliation CSV</a
			><button onclick={print}>Print / save PDF</button>
		</div>
		{#each [['Giving by month', report.byMonth, 'monthly'], ['Giving by campaign', report.byCampaign, 'campaign'], ['Giving by source', report.bySource, 'source']] as [title, rows, widget]}{#if widgets.includes(widget)}<!-- svelte-ignore a11y_no_noninteractive_tabindex (Scrollable report tables need keyboard focus for horizontal scrolling.) -->
				<div class="table-wrap" role="region" tabindex="0" aria-label={title}>
					<table>
						<caption>{title}</caption><thead
							><tr
								><th>Dimension</th><th>Original gifts</th><th>Gross</th><th>Refunds</th><th
									>Disputes</th
								><th>Net recorded</th></tr
							></thead
						><tbody
							>{#each rows as row}<tr
									><th>{campaigns.find((c: any) => c.id === row.key)?.name || row.key}</th><td
										>{row.giftCount}</td
									><td>{money(row.grossMinor)}</td><td>{money(row.refundMinor)}</td><td
										>{money(row.disputeMinor)}</td
									><td>{money(row.netRecordedMinor)}</td></tr
								>{:else}<tr><td colspan="6">No recorded activity.</td></tr>{/each}</tbody
						>
					</table>
				</div>{/if}{/each}
		{#if widgets.includes('cohorts')}<!-- svelte-ignore a11y_no_noninteractive_tabindex (Scrollable report tables need keyboard focus for horizontal scrolling.) -->
			<div class="table-wrap" role="region" tabindex="0" aria-label="First-gift cohorts">
				<table>
					<caption>First-gift cohorts</caption><thead
						><tr><th>First gift month</th><th>Donors</th><th>Active in selected period</th></tr
						></thead
					><tbody
						>{#each report.cohorts as row}<tr
								><th>{row.month}</th><td>{row.donors}</td><td>{row.activeInSelectedPeriod}</td></tr
							>{/each}</tbody
					>
				</table>
			</div>{/if}
		{#if widgets.includes('pipeline') && report.prospectFunnel !== null}<p class="muted">
				Prospect, introduction, email, and board panels are organization-wide current snapshots,
				separate from the selected gift currency.
			</p>
			<div class="metrics">
				{#each [['Prospect funnel', report.prospectFunnel], ['Introduction outcomes', report.introductionOutcomes]] as [title, values]}<article
					>
						<h2>{title}</h2>
						{#each Object.entries(values) as [key, count]}<p>
								{key.replaceAll('_', ' ')}: {count}
							</p>{/each}
					</article>{/each}
				<article>
					<h2>Email delivery</h2>
					{#each report.emailDelivery as row}<p>{row.status}: {row.count}</p>{:else}<p>
							No delivery records.
						</p>{/each}
					<p>Open rates are not used as reliable engagement evidence.</p>
				</article>
				<article>
					<h2>Board stewardship</h2>
					<p>
						{report.boardEngagement?.members || 0} board or volunteer members assigned · {report
							.boardEngagement?.assigned || 0} tasks · {report.boardEngagement?.completed || 0} completed
					</p>
				</article>
			</div>{/if}
		{#if widgets.includes('dictionary')}<details>
				<summary>Data dictionary</summary>
				<p>{report.ledger.definition}</p>
				{#each Object.entries(report.definitions) as [key, value]}<p>
						<strong>{key}:</strong>
						{value}
					</p>{/each}
				<p>
					{report.recurring?.definition ||
						'Current active recurring commitments are excluded when a date range is selected because this is a current-state snapshot.'}
				</p>
				<p>{report.retention.definition}</p>
			</details>{/if}{/if}
	<ReportSchedules {tenant} filters={Object.fromEntries(query())} />
</section>

<style>
	.reports {
		display: grid;
		gap: 1.2rem;
	}
	.filters,
	.actions {
		display: flex;
		align-items: end;
		gap: 0.8rem;
		flex-wrap: wrap;
	}
	label {
		display: grid;
		gap: 0.3rem;
	}
	input,
	select,
	button {
		font: inherit;
		padding: 0.6rem;
		border: 1px solid var(--border);
		border-radius: 8px;
		background: var(--surface);
		color: var(--text);
	}
	.metrics {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
		gap: 0.8rem;
	}
	.metrics article,
	details {
		padding: 1.1rem;
		border: 1px solid var(--border);
		border-radius: 12px;
	}
	.metrics strong {
		display: block;
		font-size: 1.7rem;
		margin-top: 0.6rem;
	}
	.table-wrap {
		overflow: auto;
	}
	table {
		border-collapse: collapse;
		width: 100%;
		text-align: left;
	}
	caption {
		text-align: left;
		font-weight: 600;
		margin: 0.6rem 0;
	}
	td,
	th {
		padding: 0.8rem;
		border-bottom: 1px solid var(--border);
	}
	.primary {
		background: var(--accent);
		color: white;
	}
	@media print {
		.filters,
		.actions {
			display: none;
		}
		.metrics {
			grid-template-columns: repeat(3, 1fr);
		}
		table {
			font-size: 10pt;
		}
	}
</style>
