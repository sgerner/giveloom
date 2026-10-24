<script lang="ts">
	import { onMount } from 'svelte';
	import { CalendarDays, Check, ExternalLink, Plus, Ticket, Users } from 'lucide-svelte';
	let { tenant } = $props<{ tenant: string }>();
	let events = $state<any[]>([]),
		selectedId = $state(''),
		event = $state<any>(null),
		error = $state(''),
		message = $state(''),
		busy = $state(false);
	let ticketName = $state('General admission'),
		ticketPrice = $state(0),
		ticketCapacity = $state<number | null>(null),
		sponsorName = $state(''),
		sponsorTier = $state('Community'),
		sponsorAmount = $state(0),
		volunteerName = $state(''),
		volunteerCapacity = $state(1);
	const api = '/api/v1/events';
	async function request(path: string, init: RequestInit = {}) {
		const response = await fetch(path, {
			...init,
			headers: { 'content-type': 'application/json', ...(init.headers || {}) }
		});
		const body = await response
			.json()
			.catch(() => ({ error: 'The server returned an unreadable response.' }));
		if (!response.ok) throw new Error(body.error || 'Request failed.');
		return body;
	}
	async function list() {
		events = (await request(api)).events;
		if (!selectedId && events[0]) await select(events[0].id);
	}
	async function select(id: string) {
		selectedId = id;
		event = await request(`${api}/${id}`);
	}
	function slug(name: string) {
		return (
			name
				.toLowerCase()
				.normalize('NFKD')
				.replace(/[^a-z0-9]+/g, '-')
				.replace(/^-|-$/g, '') || `event-${Date.now()}`
		);
	}
	async function create() {
		error = '';
		busy = true;
		try {
			const now = new Date();
			now.setDate(now.getDate() + 30);
			const result = await request(api, {
				method: 'POST',
				body: JSON.stringify({
					tenant,
					event: {
						name: 'New community event',
						publicSlug: `new-event-${crypto.randomUUID().slice(0, 8)}`,
						description: 'Join us for a gathering to grow good together.',
						startsAt: now.toISOString(),
						timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
						venue: '',
						capacity: null
					}
				})
			});
			await list();
			await select(result.id);
			message = 'Event draft created.';
		} catch (e) {
			error = e instanceof Error ? e.message : 'Event could not be created.';
		} finally {
			busy = false;
		}
	}
	async function save() {
		if (!event) return;
		error = '';
		busy = true;
		try {
			const result = await request(`${api}/${selectedId}`, {
				method: 'PATCH',
				body: JSON.stringify({
					expectedVersion: event.version,
					name: event.name,
					publicSlug: event.publicSlug,
					description: event.description,
					startsAt: new Date(event.startsAt).toISOString(),
					endsAt: event.endsAt ? new Date(event.endsAt).toISOString() : '',
					timezone: event.timezone,
					venue: event.venue,
					capacity: event.capacity === null ? null : Number(event.capacity)
				})
			});
			event = { ...event, ...result };
			message = `Saved version ${event.version}.`;
		} catch (e) {
			error = e instanceof Error ? e.message : 'Event could not be saved.';
		} finally {
			busy = false;
		}
	}
	async function publish() {
		error = '';
		try {
			await request(`${api}/${selectedId}/publish`, { method: 'POST' });
			await list();
			await select(selectedId);
			message = 'Public registration is open.';
		} catch (e) {
			error = e instanceof Error ? e.message : 'Event could not be published.';
		}
	}
	async function addTicket() {
		try {
			await request(`${api}/${selectedId}/tickets`, {
				method: 'POST',
				body: JSON.stringify({
					name: ticketName,
					priceMinor: Number(ticketPrice),
					capacity: ticketCapacity === null ? null : Number(ticketCapacity),
					description: ''
				})
			});
			await select(selectedId);
			ticketName = '';
			ticketPrice = 0;
			ticketCapacity = null;
			message = 'Ticket type added.';
		} catch (e) {
			error = e instanceof Error ? e.message : 'Ticket could not be added.';
		}
	}
	async function addSponsor() {
		try {
			await request(`${api}/${selectedId}/sponsors`, {
				method: 'POST',
				body: JSON.stringify({
					organizationName: sponsorName,
					tier: sponsorTier,
					amountMinor: Number(sponsorAmount),
					status: 'prospect'
				})
			});
			await select(selectedId);
			sponsorName = '';
			message = 'Sponsor record added.';
		} catch (e) {
			error = e instanceof Error ? e.message : 'Sponsor could not be added.';
		}
	}
	async function addOpportunity() {
		try {
			await request(`${api}/${selectedId}/volunteer-opportunities`, {
				method: 'POST',
				body: JSON.stringify({
					name: volunteerName,
					capacity: Number(volunteerCapacity),
					description: ''
				})
			});
			await select(selectedId);
			volunteerName = '';
			message = 'Volunteer opportunity added.';
		} catch (e) {
			error = e instanceof Error ? e.message : 'Opportunity could not be added.';
		}
	}
	async function checkIn(registrationId: string) {
		try {
			await request(`${api}/${selectedId}/registrations/${registrationId}/check-in`, {
				method: 'POST'
			});
			await select(selectedId);
			message = 'Attendee checked in.';
		} catch (e) {
			error = e instanceof Error ? e.message : 'Check-in failed.';
		}
	}
	onMount(() => {
		void list().catch(
			(e) => (error = e instanceof Error ? e.message : 'Events could not be loaded.')
		);
	});
</script>

<section class="event-manager" aria-labelledby="event-manager-title">
	<header class="manager-head">
		<div>
			<p class="eyebrow">GATHER THE COMMUNITY</p>
			<h2 id="event-manager-title">Event manager</h2>
			<p>
				Publish an event page, manage RSVPs and paid tickets, thank sponsors, and organize
				volunteers.
			</p>
		</div>
		<button class="primary" type="button" onclick={create}><Plus size={17} /> New event</button>
	</header>
	{#if error}<p role="alert" class="notice error">{error}</p>{/if}{#if message}<p
			role="status"
			class="notice"
		>
			{message}
		</p>{/if}
	{#if event}<div class="event-layout">
			<nav class="event-list" aria-label="Events">
				{#each events as item}<button
						type="button"
						class:current={selectedId === item.id}
						onclick={() => void select(item.id)}
						><strong>{item.name}</strong><span
							>{item.status} · {new Date(item.startsAt).toLocaleDateString()}</span
						></button
					>{/each}
			</nav>
			<div class="event-editor">
				<div class="event-title">
					<div>
						<p class="eyebrow">{event.status.toUpperCase()}</p>
						<h3>{event.name}</h3>
					</div>
					{#if event.status === 'published'}<a
							class="public-link"
							href={`/events/${tenant}/${event.publicSlug}`}
							target="_blank"
							rel="noopener noreferrer"><ExternalLink size={15} /> Public event page</a
						>{/if}
				</div>
				<div class="form-grid">
					<label>Event name<input bind:value={event.name} /></label><label
						>Public slug<input bind:value={event.publicSlug} /></label
					><label>Description<textarea bind:value={event.description} rows="3"></textarea></label
					><label>Venue<input bind:value={event.venue} /></label><label
						>Starts at<input
							type="datetime-local"
							value={new Date(event.startsAt).toISOString().slice(0, 16)}
							oninput={(e) =>
								(event.startsAt = new Date(
									(e.currentTarget as HTMLInputElement).value
								).toISOString())}
						/></label
					><label
						>Ends at<input
							type="datetime-local"
							value={event.endsAt ? new Date(event.endsAt).toISOString().slice(0, 16) : ''}
							oninput={(e) =>
								(event.endsAt = (e.currentTarget as HTMLInputElement).value
									? new Date((e.currentTarget as HTMLInputElement).value).toISOString()
									: '')}
						/></label
					><label>Timezone<input bind:value={event.timezone} /></label><label
						>Total capacity<input type="number" min="1" bind:value={event.capacity} /></label
					>
				</div>
				<div class="toolbar">
					<button class="secondary" type="button" onclick={save} disabled={busy}
						><Check size={15} /> Save event</button
					><button
						class="primary"
						type="button"
						onclick={publish}
						disabled={busy || event.status === 'published'}
						><CalendarDays size={15} /> Publish event</button
					>
				</div>
				<div class="manager-grid">
					<section class="panel">
						<h3><Ticket size={17} /> Tickets and RSVPs</h3>
						<form
							onsubmit={(e) => {
								e.preventDefault();
								void addTicket();
							}}
						>
							<label>Ticket name<input bind:value={ticketName} required /></label><label
								>Price in cents<input
									type="number"
									min="0"
									bind:value={ticketPrice}
									required
								/><small
									>Set 0 for a free RSVP. Paid ticket publication requires an active Stripe
									connection.</small
								></label
							><label
								>Capacity<input
									type="number"
									min="1"
									bind:value={ticketCapacity}
									placeholder="No separate limit"
								/></label
							><button class="secondary" type="submit">Add ticket type</button>
						</form>
						{#each event.tickets as ticket}<p class="row">
								<span>{ticket.name}<small>{ticket.capacity ?? 'Unlimited'} places</small></span
								><strong
									>{ticket.priceMinor === 0
										? 'Free'
										: new Intl.NumberFormat(undefined, {
												style: 'currency',
												currency: ticket.currency
											}).format(ticket.priceMinor / 100)}</strong
								>
							</p>{/each}
						<h4>Attendee list</h4>
						{#each event.registrations as registration}<div class="attendee">
								<span
									><strong>{registration.fullName}</strong><small
										>{registration.email} · {registration.quantity} ticket(s) · {registration.status}</small
									></span
								>{#if registration.status === 'registered'}<button
										class="quiet"
										type="button"
										onclick={() => void checkIn(registration.id)}>Check in</button
									>{:else if registration.status === 'checked_in'}<span aria-label="Checked in"
										><Check size={16} /></span
									>{/if}
							</div>{/each}
					</section>
					<section class="panel">
						<h3>Sponsors</h3>
						<form
							onsubmit={(e) => {
								e.preventDefault();
								void addSponsor();
							}}
						>
							<label>Organization<input bind:value={sponsorName} required /></label><label
								>Sponsor tier<input bind:value={sponsorTier} required /></label
							><label
								>Committed amount in cents<input
									type="number"
									min="0"
									bind:value={sponsorAmount}
								/></label
							><button class="secondary" type="submit">Add sponsor</button>
						</form>
						{#each event.sponsors as sponsor}<p class="row">
								<span
									>{sponsor.organizationName}<small>{sponsor.tier} · {sponsor.status}</small></span
								><strong
									>{new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' }).format(
										sponsor.amountMinor / 100
									)}</strong
								>
							</p>{/each}
						<h3 class="volunteer-title"><Users size={17} /> Volunteer opportunities</h3>
						<form
							onsubmit={(e) => {
								e.preventDefault();
								void addOpportunity();
							}}
						>
							<label>Opportunity<input bind:value={volunteerName} required /></label><label
								>Number of volunteers<input
									type="number"
									min="1"
									bind:value={volunteerCapacity}
								/></label
							><button class="secondary" type="submit">Add opportunity</button>
						</form>
						{#each event.volunteerOpportunities as opportunity}<p class="row">
								<span
									>{opportunity.name}<small
										>{opportunity.active ? 'Open' : 'Closed'} · limit {opportunity.capacity}</small
									></span
								>
							</p>{/each}{#each event.volunteers as volunteer}<p class="volunteer">
								<strong>{volunteer.fullName}</strong><span
									>{volunteer.opportunityName} · {volunteer.email}</span
								>
							</p>{/each}
					</section>
				</div>
			</div>
		</div>{:else}<p class="empty">Create an event to manage its registration page.</p>{/if}
</section>

<style>
	.event-manager {
		display: grid;
		gap: 1rem;
		color: var(--ink);
	}
	.manager-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		border-bottom: 1px solid var(--line);
		padding-bottom: 1rem;
	}
	.manager-head h2 {
		margin: 0.25rem 0;
	}
	.manager-head p:not(.eyebrow) {
		color: var(--muted);
		max-width: 50rem;
	}
	.eyebrow {
		font-size: 0.66rem;
		letter-spacing: 0.12em;
		color: var(--muted);
	}
	.primary,
	.secondary {
		min-height: 44px;
		padding: 0.65rem 0.9rem;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 0.4rem;
		border: 1px solid var(--line);
		background: var(--accent);
		color: var(--paper);
		font: inherit;
		font-weight: 600;
	}
	.secondary {
		background: var(--soft);
		color: var(--ink);
	}
	.notice {
		padding: 0.7rem 0.9rem;
		background: var(--soft);
		border-left: 3px solid var(--accent);
	}
	.notice.error {
		border-color: var(--coral);
	}
	.event-layout {
		display: grid;
		grid-template-columns: minmax(180px, 245px) minmax(0, 1fr);
		gap: 1rem;
		align-items: start;
	}
	.event-list {
		display: grid;
		gap: 0.4rem;
	}
	.event-list button {
		text-align: left;
		padding: 0.75rem;
		border: 1px solid var(--line);
		background: var(--white);
		color: var(--ink);
	}
	.event-list .current {
		border-color: var(--accent);
		box-shadow: inset 3px 0 var(--accent);
	}
	.event-list strong,
	.event-list span {
		display: block;
	}
	.event-list span {
		font-size: 0.74rem;
		color: var(--muted);
		margin-top: 0.2rem;
	}
	.event-editor {
		border: 1px solid var(--line);
		background: var(--white);
		padding: clamp(0.9rem, 2vw, 1.4rem);
		display: grid;
		gap: 1.2rem;
		min-width: 0;
	}
	.event-title {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.8rem;
		border-bottom: 1px solid var(--line);
		padding-bottom: 0.7rem;
	}
	.event-title h3 {
		margin: 0.3rem 0;
	}
	.public-link {
		display: inline-flex;
		gap: 0.4rem;
		align-items: center;
		color: var(--accent);
		text-decoration: underline;
		font-size: 0.8rem;
	}
	.form-grid {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 0.8rem;
	}
	.form-grid label,
	.panel label {
		display: grid;
		gap: 0.35rem;
		font-size: 0.8rem;
		color: var(--muted);
	}
	.form-grid input,
	.form-grid textarea,
	.panel input {
		width: 100%;
		min-height: 43px;
		padding: 0.65rem;
		border: 1px solid var(--line);
		background: var(--paper);
		color: var(--ink);
		font: inherit;
	}
	.form-grid label:nth-child(3) {
		grid-column: 1/-1;
	}
	.toolbar {
		display: flex;
		gap: 0.6rem;
		flex-wrap: wrap;
	}
	.manager-grid {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 0.8rem;
	}
	.panel {
		border: 1px solid var(--line);
		padding: 1rem;
		min-width: 0;
	}
	.panel h3 {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		margin-bottom: 0.8rem;
	}
	.panel h4 {
		font-size: 0.9rem;
		margin: 1rem 0 0.3rem;
	}
	.panel form {
		display: grid;
		gap: 0.6rem;
	}
	.panel small {
		display: block;
		color: var(--muted);
		font-size: 0.72rem;
	}
	.panel .secondary {
		width: 100%;
	}
	.row,
	.attendee,
	.volunteer {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 0.7rem;
		padding: 0.65rem 0;
		border-bottom: 1px solid var(--line);
		font-size: 0.82rem;
	}
	.row span,
	.attendee span {
		display: grid;
		gap: 0.2rem;
	}
	.row small,
	.attendee small {
		font-size: 0.73rem;
	}
	.attendee {
		align-items: flex-start;
	}
	.quiet {
		border: 0;
		background: transparent;
		color: var(--accent);
		text-decoration: underline;
		font: inherit;
	}
	.volunteer-title {
		margin-top: 1.4rem;
	}
	.volunteer {
		display: grid;
		justify-content: start;
	}
	.volunteer span {
		font-size: 0.75rem;
		color: var(--muted);
	}
	.empty {
		padding: 2rem;
		text-align: center;
		border: 1px dashed var(--line);
	}
	@media (max-width: 850px) {
		.event-layout {
			grid-template-columns: 1fr;
		}
		.event-list {
			display: flex;
			overflow-x: auto;
		}
		.event-list button {
			min-width: 170px;
		}
	}
	@media (max-width: 600px) {
		.manager-head {
			align-items: flex-start;
			flex-direction: column;
		}
		.form-grid,
		.manager-grid {
			grid-template-columns: 1fr;
		}
		.form-grid label:nth-child(3) {
			grid-column: auto;
		}
		.event-title {
			align-items: flex-start;
			flex-direction: column;
		}
	}
</style>
