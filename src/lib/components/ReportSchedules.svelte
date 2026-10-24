<script lang="ts">
	let {
		tenant,
		reportKey = 'giving',
		filters = {}
	} = $props<{
		tenant: string;
		reportKey?: 'giving' | 'retention';
		filters?: Record<string, unknown>;
	}>();
	type Definition = {
		id: string;
		name: string;
		reportKey: 'giving' | 'retention';
		filters: Record<string, unknown>;
		scheduleId?: string | null;
		frequency?: string | null;
		localTime?: string | null;
		weekday?: number | null;
		timezone?: string | null;
		scheduleStatus?: string | null;
		nextRunAt?: string | null;
		lastRunAt?: string | null;
	};
	type Delivery = {
		id: string;
		status: string;
		scheduledFor: string;
		createdAt: string;
		lastError?: string | null;
	};
	let definitions = $state<Definition[]>([]),
		deliveries = $state<Delivery[]>([]),
		recipient = $state<{ email: string; verified: boolean } | null>(null);
	let name = $state('My giving report'),
		kind = $state<'giving' | 'retention'>('giving'),
		frequency = $state<'daily' | 'weekly' | 'monthly'>('weekly'),
		localTime = $state('09:00'),
		weekday = $state(1),
		timezone = $state(Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'),
		selectedId = $state(''),
		approved = $state(false),
		busy = $state(false),
		error = $state(''),
		notice = $state('');
	async function request(method = 'GET', body?: unknown, url = '/api/v1/report-definitions') {
		const response = await fetch(url, {
			method,
			headers: body ? { 'content-type': 'application/json' } : undefined,
			body: body ? JSON.stringify(body) : undefined,
			cache: 'no-store'
		});
		const result = await response.json();
		if (!response.ok) throw new Error(result.error || 'Saved reports are unavailable.');
		return result;
	}
	async function load() {
		try {
			const result = await request();
			definitions = result.definitions || [];
			deliveries = result.deliveries || [];
			recipient = result.recipient || null;
			if (!selectedId && definitions.length) selectedId = definitions[0].id;
		} catch (e) {
			error = e instanceof Error ? e.message : 'Saved reports are unavailable.';
		}
	}
	async function saveDefinition() {
		busy = true;
		error = '';
		notice = '';
		try {
			const result = await request('POST', { name, reportKey: kind, filters });
			const id = result.definition.id;
			await load();
			selectedId = id;
			notice = 'Saved report definition.';
		} catch (e) {
			error = e instanceof Error ? e.message : 'Report could not be saved.';
		} finally {
			busy = false;
		}
	}
	async function saveSchedule() {
		if (!selectedId) return;
		busy = true;
		error = '';
		notice = '';
		try {
			await request('POST', {
				action: 'schedule',
				definitionId: selectedId,
				frequency,
				localTime,
				weekday: frequency === 'weekly' ? weekday : undefined,
				timezone,
				approved
			});
			approved = false;
			await load();
			notice = 'Scheduled report delivery to your verified account email.';
		} catch (e) {
			error = e instanceof Error ? e.message : 'Schedule could not be saved.';
		} finally {
			busy = false;
		}
	}
	async function pauseSchedule(scheduleId: string) {
		busy = true;
		error = '';
		notice = '';
		try {
			await request(
				'DELETE',
				undefined,
				`/api/v1/report-definitions?scheduleId=${encodeURIComponent(scheduleId)}`
			);
			await load();
			notice = 'Scheduled delivery paused.';
		} catch (e) {
			error = e instanceof Error ? e.message : 'Schedule could not be paused.';
		} finally {
			busy = false;
		}
	}
	function date(value?: string | null) {
		return value
			? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(
					new Date(value)
				)
			: '—';
	}
	$effect(() => {
		kind = reportKey;
		void tenant;
		void load();
	});
</script>

<section class="report-schedules" aria-labelledby="saved-report-title">
	<div class="intro">
		<div>
			<p class="eyebrow">Keep the useful numbers close</p>
			<h2 id="saved-report-title">Saved reports & delivery</h2>
		</div>
		<p>Choose a report definition and schedule a private email to your verified account address.</p>
	</div>
	{#if error}<p class="message error" role="alert">{error}</p>{/if}{#if notice}<p
			class="message success"
			role="status"
		>
			{notice}
		</p>{/if}
	<div class="columns">
		<form
			onsubmit={(event) => {
				event.preventDefault();
				void saveDefinition();
			}}
		>
			<h3>Save a report</h3>
			<label>Report name<input bind:value={name} maxlength="160" required /></label>
			<label
				>Report<select bind:value={kind}
					><option value="giving">Giving ledger summary</option><option value="retention"
						>Donor retention</option
					></select
				></label
			>
			<button type="submit" disabled={busy}>Save definition</button>
		</form>
		<form
			onsubmit={(event) => {
				event.preventDefault();
				void saveSchedule();
			}}
		>
			<h3>Schedule delivery</h3>
			<label
				>Saved report<select bind:value={selectedId} required
					><option value="" disabled>Choose a saved report</option
					>{#each definitions as definition}<option value={definition.id}>{definition.name}</option
						>{/each}</select
				></label
			>
			<label
				>Repeat<select bind:value={frequency}
					><option value="weekly">Weekly</option><option value="daily">Daily</option><option
						value="monthly">Monthly</option
					></select
				></label
			>
			{#if frequency === 'weekly'}<label
					>Day of week<select bind:value={weekday}
						><option value={0}>Sunday</option><option value={1}>Monday</option><option value={2}
							>Tuesday</option
						><option value={3}>Wednesday</option><option value={4}>Thursday</option><option
							value={5}>Friday</option
						><option value={6}>Saturday</option></select
					></label
				>{/if}
			<div class="time-row">
				<label>Local time<input type="time" bind:value={localTime} required /></label><label
					>Timezone<input bind:value={timezone} maxlength="80" required /></label
				>
			</div>
			<p class="recipient">
				Delivery address: <strong>{recipient?.email || 'Unavailable'}</strong
				>{#if recipient && !recipient.verified}<span>
						· verify this account email before scheduling</span
					>{/if}
			</p>
			<label class="approval"
				><input type="checkbox" bind:checked={approved} required />Email this saved report to my
				verified account address on the schedule above.</label
			>
			<button type="submit" disabled={busy || !recipient?.verified || !selectedId}
				>Approve schedule</button
			>
		</form>
	</div>
	{#if definitions.length}<div class="saved">
			<h3>Your saved reports</h3>
			{#each definitions as definition}<article>
					<div>
						<strong>{definition.name}</strong><span
							>{definition.reportKey === 'giving'
								? 'Giving ledger summary'
								: 'Donor retention'}</span
						>{#if definition.scheduleId}<span
								>{definition.scheduleStatus === 'active'
									? `Next delivery ${date(definition.nextRunAt)}`
									: 'Delivery paused'}</span
							>{/if}
					</div>
					{#if definition.scheduleId && definition.scheduleStatus === 'active'}<button
							class="quiet"
							type="button"
							disabled={busy}
							onclick={() => pauseSchedule(definition.scheduleId!)}>Pause delivery</button
						>{/if}
				</article>{/each}
		</div>{/if}
	{#if deliveries.length}<details>
			<summary>Recent delivery history</summary>
			<ul>
				{#each deliveries as delivery}<li>
						<span>{date(delivery.scheduledFor)}</span><span
							class:failed={delivery.status === 'failed'}>{delivery.status}</span
						>{#if delivery.lastError}<span>{delivery.lastError}</span>{/if}
					</li>{/each}
			</ul>
		</details>{/if}
</section>

<style>
	.report-schedules {
		padding: 1.4rem 0;
		border-top: 1px solid color-mix(in srgb, currentColor 18%, transparent);
	}
	.intro {
		display: flex;
		justify-content: space-between;
		gap: 2rem;
		align-items: end;
	}
	.intro h2 {
		margin: 0.2rem 0;
		font-size: 1.6rem;
	}
	.intro > p {
		max-width: 34rem;
		color: color-mix(in srgb, currentColor 72%, transparent);
	}
	.eyebrow {
		font-size: 0.75rem;
		text-transform: uppercase;
		letter-spacing: 0.12em;
		color: var(--muted);
	}
	.columns {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(min(100%, 19rem), 1fr));
		gap: 2rem;
		margin-top: 1.5rem;
	}
	.columns form {
		display: grid;
		gap: 0.8rem;
		align-content: start;
	}
	.columns h3,
	.saved h3 {
		font-size: 1.05rem;
		margin: 0 0 0.3rem;
	}
	.columns label {
		display: grid;
		gap: 0.35rem;
		font-size: 0.88rem;
	}
	.columns input:not([type='checkbox']),
	.columns select {
		min-height: 2.6rem;
		padding: 0.55rem 0.65rem;
		border: 1px solid color-mix(in srgb, currentColor 28%, transparent);
		background: transparent;
		color: inherit;
	}
	.time-row {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 0.7rem;
	}
	.approval {
		display: flex !important;
		grid-template-columns: none !important;
		align-items: start;
		gap: 0.55rem !important;
	}
	.approval input {
		margin-top: 0.2rem;
	}
	.columns button {
		justify-self: start;
		padding: 0.6rem 0.9rem;
		background: var(--color-primary-600);
		color: white;
		border: 0;
		font-weight: 650;
	}
	.columns button:disabled {
		opacity: 0.5;
	}
	.recipient,
	.message {
		font-size: 0.85rem;
	}
	.recipient span {
		color: #9a4c00;
	}
	.saved {
		margin-top: 2rem;
	}
	.saved article {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 1rem;
		padding: 0.8rem 0;
		border-top: 1px solid color-mix(in srgb, currentColor 16%, transparent);
	}
	.saved article div {
		display: flex;
		gap: 0.7rem 1.2rem;
		align-items: baseline;
		flex-wrap: wrap;
	}
	.saved article span {
		font-size: 0.83rem;
		color: color-mix(in srgb, currentColor 70%, transparent);
	}
	.quiet {
		background: transparent;
		border: 1px solid color-mix(in srgb, currentColor 28%, transparent);
		padding: 0.45rem 0.7rem;
		color: inherit;
	}
	.message.error,
	.failed {
		color: #a52323;
	}
	.message.success {
		color: #167043;
	}
	details {
		margin-top: 1rem;
	}
	summary {
		cursor: pointer;
	}
	details ul {
		padding-left: 1.2rem;
	}
	details li {
		display: flex;
		gap: 1rem;
		padding: 0.3rem 0;
		font-size: 0.85rem;
	}
	@media (max-width: 640px) {
		.intro {
			display: block;
		}
		.saved article {
			align-items: start;
			flex-direction: column;
		}
	}
</style>
