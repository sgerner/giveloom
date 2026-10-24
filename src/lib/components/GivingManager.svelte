<script lang="ts">
	import { formatMoney, majorToMinor, minorToMajor } from '$lib/money';
	import { focusTrap } from '$lib/focus-trap';
	import { onMount } from 'svelte';
	import { Plus, Heart, ArrowUpRight, Check, Download, FileText } from 'lucide-svelte';
	import ContactPicker from './ContactPicker.svelte';
	let donorPicker = $state<{ clearSelection: () => void }>();
	let {
		tenant,
		contacts = [],
		campaigns = [],
		contactId,
		view = 'gifts',
		onChanged = () => {}
	} = $props<{
		tenant: string;
		contacts?: any[];
		campaigns?: any[];
		contactId?: string;
		view?: string;
		onChanged?: () => void;
	}>();
	let data = $state<any>({
			gifts: [],
			pledges: [],
			installments: [],
			credits: [],
			matches: [],
			tributes: [],
			financialDetails: []
		}),
		funds = $state<any[]>([]),
		loading = $state(true),
		pending = $state(false),
		error = $state(''),
		saved = $state(''),
		action = $state(''),
		form = $state<any>({}),
		confirmed = $state(false),
		installmentRows = $state<any[]>([]),
		year = $state(new Date().getFullYear()),
		statement = $state<any>(null),
		nextCursor = $state<string | null>(null),
		giftKind = $state('all'),
		giftSearch = $state(''),
		giftSearchTimer = $state<any>(null),
		nextSubscriptionCursor = $state<string | null>(null),
		monthFilter = $state('');
	const money = (n: number, code = 'USD') => formatMoney(n || 0, code);
	const person = (id: string, gift?: any) =>
		gift?.contactName || contacts.find((c: any) => c.id === id)?.name || 'Anonymous / unassigned';
	const campaign = (id: string, gift?: any) =>
		gift?.campaignName || campaigns.find((c: any) => c.id === id)?.name || 'General giving';
	onMount(() => {
		monthFilter = new URLSearchParams(window.location.search).get('month') || '';
		void load();
	});
	async function load(append = false) {
		loading = true;
		try {
			const params = new URLSearchParams({ limit: '50' });
			if (contactId) params.set('contactId', contactId);
			if (nextCursor && append) params.set('cursor', nextCursor);
			if (giftSearch.trim()) params.set('q', giftSearch.trim());
			if (view === 'recurring') params.set('kind', 'recurring');
			else if (giftKind !== 'all') params.set('kind', giftKind);
			if (monthFilter) params.set('month', monthFilter);
			const r = await fetch('/api/v1/giving?' + params.toString());
			const v = await r.json();
			if (!r.ok) throw new Error(v.error);
			nextCursor = v.nextCursor || null;
			nextSubscriptionCursor = v.nextSubscriptionCursor || null;
			data = append ? { ...v, gifts: [...data.gifts, ...v.gifts] } : v;
			const f = await fetch('/api/v1/campaigns/funds');
			if (f.ok) {
				const result = await f.json();
				funds = result.items || result.funds || result;
			}
		} catch (e) {
			error = e instanceof Error ? e.message : 'Giving unavailable';
		} finally {
			loading = false;
		}
	}
	function applyGiftFilters() {
		nextCursor = null;
		void load(false);
	}
	function debounceGiftSearch() {
		clearTimeout(giftSearchTimer);
		giftSearchTimer = setTimeout(applyGiftFilters, 250);
	}
	let selectedGift = $state<any>(null);
	let giftLookupTimer: ReturnType<typeof setTimeout> | undefined;
	async function lookupGift(queryText: string) {
		clearTimeout(giftLookupTimer);
		if (!queryText.trim()) {
			selectedGift = null;
			return;
		}
		giftLookupTimer = setTimeout(async () => {
			try {
				const params = new URLSearchParams({ limit: '20', q: queryText.trim() });
				if (contactId) params.set('contactId', contactId);
				const r = await fetch('/api/v1/giving?' + params);
				const v = await r.json();
				if (r.ok) {
					selectedGift = v.gifts || [];
				}
			} catch {
				/* the action remains available for gifts in the current page */
			}
		}, 220);
	}
	async function loadMoreSubscriptions() {
		if (!nextSubscriptionCursor) return;
		loading = true;
		try {
			const params = new URLSearchParams({
				limit: '1',
				subscriptionCursor: nextSubscriptionCursor
			});
			if (contactId) params.set('contactId', contactId);
			const r = await fetch('/api/v1/giving?' + params);
			const v = await r.json();
			if (!r.ok) throw new Error(v.error);
			data = { ...data, subscriptions: [...data.subscriptions, ...(v.subscriptions || [])] };
			nextSubscriptionCursor = v.nextSubscriptionCursor || null;
		} catch (e) {
			error = e instanceof Error ? e.message : 'Recurring commitments unavailable.';
		} finally {
			loading = false;
		}
	}
	function start(type: string, gift?: any) {
		action = type;
		selectedGift = null;
		confirmed = false;
		error = '';
		statement = null;
		form =
			type === 'record'
				? {
						currency: 'USD',
						kind: 'one_time',
						method: 'cash',
						contactId: contactId || '',
						fee: 0,
						requestKey: crypto.randomUUID()
					}
				: type === 'pledge'
					? { currency: 'USD', contactId: contactId || '' }
					: type === 'correction'
						? {
								giftId: gift?.id,
								type: 'refund',
								requestKey: crypto.randomUUID(),
								currency: gift?.currency || 'USD',
								amount: minorToMajor(gift?.amountMinor || 0, gift?.currency || 'USD')
							}
						: type === 'soft_credit'
							? { giftId: gift?.id, contactId: contactId || '' }
							: { giftId: gift?.id };
		installmentRows = [{ amount: '', dueAt: '' }];
	}
	async function submit() {
		pending = true;
		error = '';
		try {
			const body = { ...form, action };
			if (['record', 'pledge', 'correction', 'soft_credit', 'matching'].includes(action)) {
				body.amountMinor = majorToMinor(
					body.amount,
					body.currency || data.gifts.find((g: any) => g.id === body.giftId)?.currency || 'USD'
				);
				delete body.amount;
			}
			if (action === 'record') {
				body.feeMinor = majorToMinor(body.fee || 0, body.currency || 'USD');
				delete body.fee;
				if (body.kind === 'in_kind') body.method = 'in_kind';
				if (body.honoree) {
					body.tribute = {
						honoree: body.honoree,
						kind: body.tributeKind || 'honor',
						...(body.notifyEmail ? { notifyEmail: body.notifyEmail } : {})
					};
				}
				delete body.honoree;
				delete body.tributeKind;
				delete body.notifyEmail;
			}
			if (action === 'pledge') {
				body.dueAt = new Date(body.dueAt + 'T12:00:00Z').toISOString();
				body.installments = installmentRows.map((row) => ({
					amountMinor: majorToMinor(row.amount, body.currency || 'USD'),
					dueAt: new Date(row.dueAt + 'T12:00:00Z').toISOString()
				}));
			}
			if (action === 'correction') body.confirmed = confirmed;
			for (const key of [
				'contactId',
				'campaignId',
				'fundId',
				'checkReference',
				'designation',
				'inKindDescription'
			])
				if (!body[key]) delete body[key];
			const r = await fetch('/api/v1/giving', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body)
			});
			const v = await r.json();
			if (!r.ok) throw new Error(v.error);
			saved = 'Recorded with immutable financial history.';
			action = '';
			await load();
			onChanged();
		} catch (e) {
			error = e instanceof Error ? e.message : 'Could not save this financial event';
		} finally {
			pending = false;
		}
	}
	async function fetchStatement() {
		error = '';
		const selectedContact = contactId || form.statementContact;
		if (!selectedContact) {
			error = 'Choose a donor to prepare a statement.';
			return;
		}
		if (
			!Number.isInteger(Number(year)) ||
			Number(year) < 2000 ||
			Number(year) > new Date().getFullYear()
		) {
			error = 'Choose a valid calendar year.';
			return;
		}
		try {
			const r = await fetch(
				'/api/v1/giving/statement?contactId=' +
					encodeURIComponent(selectedContact) +
					'&year=' +
					encodeURIComponent(String(year))
			);
			const v = await r.json();
			if (!r.ok) throw new Error(v.error);
			statement = v;
		} catch (e) {
			error = e instanceof Error ? e.message : 'Statement unavailable';
		}
	}
</script>

<section class="giving-manager">
	{#if !contactId}<div class="page-heading compact">
			<div>
				<span class="eyebrow">GENEROSITY, RECORDED WITH CARE</span>
				<h1>Every gift matters<span class="heading-dot">.</span></h1>
				<p class="lede">
					Original gifts, commitments, attribution, and corrections—with a clear trail.
				</p>
			</div>
			<button class="primary" onclick={() => start('record')}
				><Plus size={17} />Record a gift</button
			>
		</div>
		<nav class="tabs" aria-label="Giving sections">
			{#each [{ id: 'gifts', label: 'Gift ledger' }, { id: 'recurring', label: 'Recurring' }, { id: 'pledges', label: 'Pledges' }, { id: 'campaigns', label: 'Campaigns' }, { id: 'events', label: 'Events' }] as tab}<a
					href={'/app/' + tenant + '/' + tab.id}
					class:chosen={view === tab.id}>{tab.label}</a
				>{/each}
		</nav>{/if}
	{#if error}<p class="banner error" role="alert">{error}</p>{/if}{#if saved}<p
			class="banner success"
			role="status"
		>
			{saved}
		</p>{/if}
	{#if Object.values(data.relatedDetailsTruncated || {}).some((value: any) => value)}<p
			role="status"
			class="muted"
		>
			Related lists are capped in this response. Exact counts: {data.relatedCounts?.pledges || 0} pledges,
			{data.relatedCounts?.installments || 0} installments, {data.relatedCounts?.softCredits || 0} soft
			credits, {data.relatedCounts?.matches || 0} matches, {data.relatedCounts?.tributes || 0} tributes.
		</p>{/if}
	{#if loading}<p aria-busy="true">Reconciling the good…</p>{:else}
		{#if view === 'pledges'}<div class="section-heading">
				<h2>Promises, with a plan</h2>
				<button class="primary" onclick={() => start('pledge')}
					><Plus size={16} />Record pledge</button
				>
			</div>
			{#each data.pledges as pledge}<article class="pledge-row">
					<div>
						<h3>{person(pledge.contactId, pledge)}</h3>
						<p>
							{money(pledge.amountMinor, pledge.currency)} · {pledge.status} · Due {new Date(
								pledge.dueAt
							).toLocaleDateString()}
						</p>
						<p class="muted small">{pledge.description}</p>
					</div>
					<div>
						{#each data.installments.filter((i: any) => i.pledgeId === pledge.id) as installment}<div
								class="installment"
							>
								<span
									>{money(installment.amountMinor, pledge.currency)} · {new Date(
										installment.dueAt
									).toLocaleDateString()}</span
								>{#if installment.giftId}<span class="pill">Fulfilled</span>{:else}<button
										class="text-button"
										onclick={() => {
											start('fulfill_installment');
											form.installmentId = installment.id;
										}}>Link recorded gift <ArrowUpRight size={14} /></button
									>{/if}
							</div>{/each}
					</div>
				</article>{:else}<p class="empty-inline">
					No pledges recorded. Installments keep commitments separate from actual gifts.
				</p>{/each}
		{:else}<div class="toolbar">
				<label class="search-field"
					><input
						aria-label="Search gift ledger"
						placeholder="Search a supporter or campaign"
						bind:value={giftSearch}
						oninput={debounceGiftSearch}
					/></label
				>{#if contactId}<button class="primary" onclick={() => start('record')}
						><Plus size={16} />Record gift</button
					>{/if}<button class="secondary" onclick={() => start('statement')}
					><FileText size={16} />Year-end summary</button
				>
				{#if !contactId}<label class="kind-filter"
						>Gift kind<select bind:value={giftKind} onchange={applyGiftFilters}
							><option value="all">All kinds</option><option value="one_time">One-time</option
							><option value="recurring">Recurring</option><option value="in_kind">In-kind</option
							><option value="correction">Corrections</option></select
						></label
					>{/if}
				<label class="kind-filter"
					>Month<input
						type="month"
						aria-label="Filter gifts by UTC month"
						bind:value={monthFilter}
						onchange={applyGiftFilters}
					/></label
				>
			</div>
			{#if data.summary?.length}<div
					class="ledger-summary"
					aria-label="All giving totals by currency"
				>
					{#each data.summary as total}<p>
							<strong>{total.currency}</strong> · {total.giftCount} recorded gifts · gross {money(
								total.grossMinor,
								total.currency
							)} · corrections {money(
								total.refundMinor + total.disputeMinor - total.reinstatementMinor,
								total.currency
							)} · net {money(total.netRecordedMinor, total.currency)}
						</p>{/each}
				</div>{/if}
			{#if view === 'recurring'}<section
					class="recurring-commitments"
					aria-labelledby="recurring-commitments-title"
				>
					<h2 id="recurring-commitments-title">Current recurring commitments</h2>
					<p class="muted">
						Subscription amounts are commitments; only payments in the history below count as
						recorded gifts. Manage subscription changes through the donor portal.
					</p>
					{#each data.subscriptions || [] as subscription}<article>
							<strong>{subscription.contactName}</strong><span
								>{money(subscription.amountMinor, subscription.currency)} / {subscription.frequency ===
								'annual'
									? 'year'
									: 'month'}</span
							><span class="pill">{subscription.status.replaceAll('_', ' ')}</span><small
								>Started {new Date(subscription.createdAt).toLocaleDateString()}</small
							><a href={'/app/' + tenant + '/contacts/' + subscription.contactId}>Open supporter</a>
						</article>{:else}<p class="muted">
							No active, past-due, or ended recurring subscriptions.
						</p>{/each}{#if nextSubscriptionCursor}<button
							class="secondary"
							disabled={loading}
							onclick={loadMoreSubscriptions}>Load more commitments</button
						>{/if}
					<h2>Historical recurring payments</h2>
				</section>{/if}
			<div class="table-scroll">
				<table>
					<thead
						><tr
							><th>DONOR / DATE</th><th>GIFT</th><th>CAMPAIGN / FUND</th><th>EVENT</th><th
								>ACTIONS</th
							></tr
						></thead
					><tbody
						>{#each data.gifts.filter((g: any) => view !== 'recurring' || g.kind === 'recurring') as gift}<tr
								><td
									>{#if gift.contactId}<a href={'/app/' + tenant + '/contacts/' + gift.contactId}
											><strong>{person(gift.contactId, gift)}</strong></a
										>{:else}<strong>{person(gift.contactId, gift)}</strong>{/if}
									><small>{new Date(gift.occurredAt || gift.createdAt).toLocaleDateString()}</small
									></td
								><td
									><strong>{money(gift.amountMinor, gift.currency)}</strong><small
										>{gift.currency} · {gift.kind.replaceAll('_', ' ')}</small
									></td
								><td
									>{campaign(gift.campaignId, gift)}<small
										>{funds.find((f) => f.id === gift.fundId)?.name || 'No fund designation'}</small
									></td
								><td
									><span class="pill">{gift.status}</span>{#if gift.correctionOf}<small
											>Corrects {gift.correctionOf.slice(0, 8)}</small
										>{/if}</td
								><td
									>{#if gift.status === 'recorded' && gift.kind !== 'correction'}<div
											class="row-actions"
										>
											<button class="text-button" onclick={() => start('correction', gift)}
												>Correct</button
											><button class="text-button" onclick={() => start('soft_credit', gift)}
												>Soft credit</button
											><button class="text-button" onclick={() => start('matching', gift)}
												>Match</button
											>
										</div>{:else}<span class="muted small">Immutable event</span>{/if}</td
								></tr
							>{:else}<tr><td colspan="5" class="empty-inline">No gifts match this view.</td></tr
							>{/each}</tbody
					>
				</table>
			</div>
			{#if nextCursor}<button
					class="secondary load-more"
					disabled={loading}
					onclick={() => void load(true)}>{loading ? 'Loading…' : 'Load more gifts'}</button
				>{/if}
			<p class="muted small ledger-note">
				Soft credits and pledges do not increase gross giving. Refunds/disputes are correcting
				events; originals remain unchanged. Amounts are never converted between currencies.
			</p>
			<div class="attribution-columns">
				<section>
					<h3>Soft-credit attribution</h3>
					{#each data.credits as credit}<p>
							{person(credit.contactId)} · {money(credit.amountMinor)}<small>{credit.reason}</small>
						</p>{:else}<p class="muted small">No soft credits recorded.</p>{/each}
				</section>
				<section>
					<h3>Matching-gift pipeline</h3>
					{#each data.matches as match}<p>
							{match.organization} · {money(match.amountMinor)}
							<span class="pill">{match.status}</span>{#if match.status !== 'received'}<button
									class="text-button"
									onclick={() => {
										start('match_received');
										form.matchId = match.id;
									}}>Link matching payment</button
								>{/if}
						</p>{:else}<p class="muted small">No expected matching gifts.</p>{/each}
				</section>
			</div>{/if}
	{/if}
	{#if action}<dialog
			open
			use:focusTrap
			aria-modal="true"
			onkeydown={(e) => {
				if (e.key === 'Escape') action = '';
			}}
			class="giving-dialog"
			aria-labelledby="giving-dialog-title"
		>
			<div class="dialog-heading">
				<h2 id="giving-dialog-title">
					{(
						{
							record: 'Record an offline gift',
							correction: 'Review a correcting event',
							pledge: 'Record a pledge',
							soft_credit: 'Attribute a soft credit',
							matching: 'Track an expected match',
							match_received: 'Link the matching payment',
							fulfill_installment: 'Fulfill a pledge installment',
							statement: 'Year-end giving summary'
						} as any
					)[action]}
				</h2>
				<button class="secondary" onclick={() => (action = '')}>Close</button>
			</div>
			{#if error}<p class="banner error" role="alert">{error}</p>{/if}
			{#if action === 'statement'}<div class="stacked-form">
					{#if !contactId}<ContactPicker
							{tenant}
							bind:contactId={form.statementContact}
							label="Donor"
							required
						/>{/if}<label
						>Calendar year<input
							type="number"
							min="2000"
							max={new Date().getFullYear()}
							bind:value={year}
						/></label
					><button class="primary" onclick={fetchStatement}>Review summary</button
					>{#if statement}<h3>{statement.donorName} · {statement.year}</h3>
						{#each statement.currencies as summary}<p>
								{summary.currency}: gross {money(summary.grossMinor, summary.currency)}, refunds {money(
									summary.refundMinor,
									summary.currency
								)}, net {money(summary.netRecordedMinor, summary.currency)}
							</p>{/each}
						<p class="muted small">{statement.disclaimer}</p>
						<a
							class="secondary"
							target="_blank"
							rel="noreferrer"
							href={'/api/v1/giving/statement?contactId=' +
								encodeURIComponent(contactId || form.statementContact) +
								'&year=' +
								encodeURIComponent(String(year)) +
								'&format=html'}><Download size={16} />Print statement</a
						>{/if}
				</div>
			{:else}<form
					class="stacked-form"
					onsubmit={(e) => {
						e.preventDefault();
						submit();
					}}
				>
					{#if ['record', 'pledge', 'soft_credit'].includes(action)}<ContactPicker
							bind:this={donorPicker}
							{tenant}
							bind:contactId={form.contactId}
							label="Donor / credited supporter"
							required={action !== 'record'}
						/>{#if action === 'record'}<button
								type="button"
								class="text-button"
								onclick={() => {
									donorPicker?.clearSelection();
									form.contactId = '';
								}}>Record as anonymous / unassigned</button
							>{/if}{/if}
					{#if ['record', 'pledge', 'correction', 'soft_credit', 'matching'].includes(action)}<div
							class="field-pair"
						>
							<label
								>Amount<input
									type="number"
									min="0.01"
									step="0.01"
									required
									bind:value={form.amount}
								/></label
							>{#if ['record', 'pledge'].includes(action)}<label
									>ISO currency<input required maxlength="3" bind:value={form.currency} /></label
								>{/if}
						</div>{/if}
					{#if ['record', 'pledge'].includes(action)}<label
							>Campaign<select bind:value={form.campaignId}
								><option value="">General giving</option>{#each campaigns as campaign}<option
										value={campaign.id}>{campaign.name}</option
									>{/each}</select
							></label
						>{/if}
					{#if action === 'record'}<div class="field-pair">
							<label
								>Gift type<select bind:value={form.kind}
									><option value="one_time">One time</option><option value="recurring"
										>Recorded recurring payment</option
									><option value="in_kind">In-kind</option></select
								></label
							><label
								>Payment method<select bind:value={form.method}
									><option value="cash">Cash</option><option value="check">Check</option><option
										value="ach">ACH</option
									><option value="wire">Wire</option><option value="other">Other</option><option
										value="in_kind">In-kind</option
									></select
								></label
							>
						</div>
						<label
							>Fund<select bind:value={form.fundId}
								><option value="">Campaign default / undesignated</option
								>{#each funds as fund}<option value={fund.id}>{fund.name}</option>{/each}</select
							></label
						>
						<div class="field-pair">
							<label
								>Fees (same currency)<input
									type="number"
									min="0"
									step="0.01"
									bind:value={form.fee}
								/></label
							><label>Check / transfer reference<input bind:value={form.checkReference} /></label>
						</div>
						<label>Designation / restriction<input bind:value={form.designation} /></label><label
							class="checkbox-label"
							><input type="checkbox" bind:checked={form.restricted} />Restricted gift</label
						><label class="checkbox-label"
							><input type="checkbox" bind:checked={form.anonymous} />Anonymous giving (public
							identity remains private)</label
						>{#if form.kind === 'in_kind'}<label
								>In-kind description<textarea required bind:value={form.inKindDescription}
								></textarea></label
							>{/if}
						<details>
							<summary>Add a tribute</summary><label
								>Honoree<input bind:value={form.honoree} /></label
							><label
								>Tribute<select bind:value={form.tributeKind}
									><option value="honor">In honor</option><option value="memory">In memory</option
									></select
								></label
							><label
								>Optional notification email<input
									type="email"
									bind:value={form.notifyEmail}
								/></label
							>
							<p class="muted small">
								Records the notification request. No unapproved message is sent.
							</p>
						</details>
						<p class="muted small">
							This records an offline payment. No payment is charged. Verify the donor, currency,
							designation and amount before saving.
						</p>
					{:else if action === 'correction'}<label
							>Event type<select bind:value={form.type}
								><option value="refund">Refund</option><option value="dispute">Dispute</option
								><option value="reinstatement">Won dispute / reinstatement</option></select
							></label
						><label
							>Reason<textarea required minlength="5" bind:value={form.reason}></textarea></label
						><label class="checkbox-label"
							><input type="checkbox" bind:checked={confirmed} />I reviewed the original gift and
							approve this immutable correction.</label
						>
						<p class="muted small">
							Records an offline correcting event; it does not instruct Stripe to refund a card.
						</p>
					{:else if action === 'pledge'}<label
							>Due date<input type="date" required bind:value={form.dueAt} /></label
						><label>Description<textarea bind:value={form.description}></textarea></label>
						<h3>Installments</h3>
						{#each installmentRows as row}<div class="field-pair">
								<label
									>Amount<input
										type="number"
										min="0.01"
										step="0.01"
										required
										bind:value={row.amount}
									/></label
								><label>Due date<input type="date" required bind:value={row.dueAt} /></label>
							</div>{/each}<button
							type="button"
							class="secondary"
							onclick={() => installmentRows.push({ amount: '', dueAt: '' })}
							>Add installment</button
						>
						<p class="muted small">
							Installments must add up to the exact pledge. A pledge is not a recorded donation.
						</p>
					{:else if action === 'soft_credit'}<label
							>Attribution reason<textarea required bind:value={form.reason}></textarea></label
						>
						<p class="muted small">
							Recognizes another supporter without increasing financial totals.
						</p>
					{:else if action === 'matching'}<label
							>Matching organization<input required bind:value={form.organization} /></label
						>
					{:else if ['fulfill_installment', 'match_received'].includes(action)}<label
							>Recorded gift<select
								required
								value={action === 'match_received' ? form.matchedGiftId : form.giftId}
								onchange={(event) => {
									if (action === 'match_received') form.matchedGiftId = event.currentTarget.value;
									else form.giftId = event.currentTarget.value;
								}}
								><option value="">Choose payment</option
								>{#each (selectedGift || data.gifts).filter((g: any) => g.status === 'recorded' && g.kind !== 'correction') as gift}<option
										value={gift.id}
										>{person(gift.contactId)} · {money(gift.amountMinor, gift.currency)} · {gift.id.slice(
											0,
											8
										)}</option
									>{/each}</select
							></label
						>
						<input
							aria-label="Find an older recorded gift"
							placeholder="Search all gifts by supporter, campaign, or ID"
							oninput={(e) => lookupGift(e.currentTarget.value)}
						/>
						<p class="muted small">
							The donor, amount, currency and payment status must reconcile.
						</p>{/if}
					<button class="primary" disabled={pending || (action === 'correction' && !confirmed)}
						><Check size={16} />{pending ? 'Recording…' : 'Confirm reviewed record'}</button
					>
				</form>{/if}
		</dialog>{/if}
</section>

<style>
	.row-actions {
		display: flex;
		gap: 14px;
	}
	.ledger-note {
		margin: 20px 0;
	}
	.attribution-columns {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 30px;
		border-top: 1px solid var(--line);
		padding: 25px 0;
	}
	.attribution-columns h3 {
		margin-bottom: 20px;
	}
	.attribution-columns p {
		font-size: 12px;
		padding: 10px 0;
	}
	.attribution-columns small {
		display: block;
		color: var(--muted);
		margin-top: 5px;
	}
	.pledge-row {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 30px;
		border-bottom: 1px solid var(--line);
		padding: 25px 0;
	}
	.pledge-row p {
		font-size: 12px;
		margin-top: 8px;
	}
	.installment {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 15px;
		padding: 10px 0;
		border-bottom: 1px solid var(--line);
		font-size: 11px;
	}
	.giving-dialog {
		position: fixed;
		inset: 6vh auto auto 50%;
		transform: translateX(-50%);
		z-index: 80;
		background: var(--paper);
		color: var(--ink);
		border: 1px solid var(--line);
		width: min(620px, 94vw);
		padding: 28px;
		max-height: 88vh;
		overflow: auto;
		box-shadow: 0 0 0 100vmax #14291f77;
	}
	.giving-dialog .dialog-heading {
		gap: 20px;
	}
	.giving-dialog h2 {
		font-size: 23px;
	}
	.giving-dialog details {
		font-size: 12px;
	}
	.giving-dialog details label {
		margin-top: 15px;
	}
	.giving-dialog summary {
		cursor: pointer;
	}
	@media (max-width: 760px) {
		.attribution-columns,
		.pledge-row {
			grid-template-columns: 1fr;
		}
		.row-actions {
			gap: 10px;
		}
		.giving-dialog {
			padding: 23px;
		}
	}
</style>
