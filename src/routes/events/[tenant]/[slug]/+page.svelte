<script lang="ts">
	import { onDestroy, onMount, tick, untrack } from 'svelte';
	import {
		loadStripe,
		type Stripe,
		type StripeElements,
		type StripePaymentElement
	} from '@stripe/stripe-js';
	import { formatMoney } from '$lib/money';
	import { CalendarDays, MapPin, Ticket, HeartHandshake } from 'lucide-svelte';
	let { data } = $props();
	let ticketTypeId = $state(untrack(() => data.tickets[0]?.id || ''));
	let quantity = $state(1);
	let fullName = $state('');
	let email = $state('');
	let message = $state('');
	let busy = $state(false);
	let ready = $state(false);
	let registrationRef = $state('');
	let paymentMount = $state<HTMLDivElement>();
	let stripe: Stripe | null = null;
	let elements: StripeElements | undefined;
	let payment: StripePaymentElement | undefined;
	let statusTimer: ReturnType<typeof setTimeout> | undefined;
	let phase = $state<'register' | 'payment' | 'pending' | 'done'>('register');
	const money = (minor: number, currency = data.currency) => formatMoney(minor, currency);
	const startsAt = $derived(
		new Intl.DateTimeFormat(undefined, {
			dateStyle: 'long',
			timeStyle: 'short',
			timeZone: data.event.timezone
		}).format(new Date(data.event.startsAt))
	);
	const selectedTicket = $derived(data.tickets.find((ticket: any) => ticket.id === ticketTypeId));
	const fmtStory = (text: string) =>
		text
			.split('\n')
			.map((line: string) => line.trim())
			.filter(Boolean);
	onMount(() => {
		ready = true;
	});

	async function register() {
		busy = true;
		message = '';
		try {
			const requestKey =
				sessionStorage.getItem(`event-request:${data.tenant}:${data.event.publicSlug}`) ||
				crypto.randomUUID();
			sessionStorage.setItem(`event-request:${data.tenant}:${data.event.publicSlug}`, requestKey);
			const response = await fetch(
				`/api/v1/events/public/${encodeURIComponent(data.tenant)}/${encodeURIComponent(data.event.publicSlug)}`,
				{
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ ticketTypeId, quantity, fullName, email, requestKey })
				}
			);
			const result = await response.json();
			if (!response.ok) throw new Error(result.error || 'Registration could not be completed.');
			if (result.publicRef) {
				registrationRef = result.publicRef;
				sessionStorage.setItem(
					`event-registration:${data.tenant}:${data.event.publicSlug}`,
					registrationRef
				);
			}
			if (result.clientSecret) {
				stripe = await loadStripe(result.publishableKey, {
					stripeAccount: result.connectedAccountId
				});
				if (!stripe) throw new Error('Secure payment fields are unavailable.');
				elements = stripe.elements({
					clientSecret: result.clientSecret,
					appearance: {
						theme: document.documentElement.classList.contains('dark') ? 'night' : 'stripe',
						variables: { colorPrimary: '#244e3d', borderRadius: '0px' }
					}
				});
				phase = 'payment';
				await tick();
				payment = elements.create('payment');
				payment.mount(paymentMount!);
			} else {
				phase = 'done';
				message = 'Your RSVP is confirmed. We sent the details to your email.';
				sessionStorage.removeItem(`event-request:${data.tenant}:${data.event.publicSlug}`);
			}
		} catch (error) {
			message = error instanceof Error ? error.message : 'Registration could not be completed.';
		} finally {
			busy = false;
		}
	}
	async function pay() {
		if (!stripe || !elements) return;
		busy = true;
		message = '';
		try {
			const result = await stripe.confirmPayment({
				elements,
				confirmParams: { return_url: location.href },
				redirect: 'if_required'
			});
			if (result.error) throw new Error(result.error.message || 'Payment could not be completed.');
			phase = 'pending';
			void pollStatus();
		} catch (error) {
			message = error instanceof Error ? error.message : 'Payment could not be completed.';
		} finally {
			busy = false;
		}
	}
	async function pollStatus() {
		if (!registrationRef) return;
		try {
			const response = await fetch(
				`/api/v1/events/public/${encodeURIComponent(data.tenant)}/${encodeURIComponent(data.event.publicSlug)}/registration-status?ref=${encodeURIComponent(registrationRef)}`,
				{ cache: 'no-store' }
			);
			const result = await response.json();
			if (result.status === 'registered' || result.status === 'checked_in') {
				phase = 'done';
				message = 'Your tickets are confirmed. We sent the details to your email.';
				sessionStorage.removeItem(`event-request:${data.tenant}:${data.event.publicSlug}`);
				return;
			}
			if (result.status === 'payment_failed' || result.status === 'cancelled') {
				message = 'Payment was not confirmed. Please start again or contact the organizer.';
				phase = 'register';
				return;
			}
			message = 'Payment is awaiting confirmation from the secure processor.';
		} catch {
			message = 'Your payment status is still being confirmed.';
		}
		statusTimer = setTimeout(pollStatus, 2500);
	}
	async function signUp(opportunityId: string) {
		const form = document.querySelector<HTMLFormElement>(
			`form[data-volunteer="${CSS.escape(opportunityId)}"]`
		);
		const values = new FormData(form || undefined);
		try {
			const response = await fetch(
				`/api/v1/events/public/${encodeURIComponent(data.tenant)}/${encodeURIComponent(data.event.publicSlug)}/volunteers`,
				{
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({
						opportunityId,
						fullName: String(values.get('name') || ''),
						email: String(values.get('email') || '')
					})
				}
			);
			const result = await response.json();
			if (!response.ok) throw new Error(result.error || 'Sign-up failed.');
			message = 'Thank you for volunteering. The organizer will follow up.';
			form?.reset();
		} catch (error) {
			message = error instanceof Error ? error.message : 'Volunteer sign-up failed.';
		}
	}
	onDestroy(() => {
		payment?.destroy();
		if (statusTimer) clearTimeout(statusTimer);
	});
</script>

<svelte:head
	><title>{data.event.name} · {data.organization}</title><meta
		name="description"
		content={data.event.description}
	/><meta name="robots" content="noindex" /></svelte:head
>
<main class="public-event" data-theme={data.branding?.theme}>
	<header>
		<a href="/" class="brand"
			>{#if data.branding?.logoUrl}<img
					src={data.branding.logoUrl}
					alt={data.organization + ' logo'}
					width="34"
					height="34"
				/>{:else}<img
					src="/brand/generous-dots.svg"
					alt=""
					width="34"
					height="34"
				/>{/if}{data.organization}</a
		><span class="eyebrow">COMMUNITY EVENT</span>
	</header>
	<section class="event-intro">
		<p class="eyebrow">A LITTLE CONNECTION. A LASTING DIFFERENCE.</p>
		<h1>{data.event.name}</h1>
		<p class="event-description">{data.event.description}</p>
		<div class="event-meta">
			<span><CalendarDays size={17} />{startsAt} · {data.event.timezone}</span
			>{#if data.event.venue}<span><MapPin size={17} />{data.event.venue}</span
				>{/if}{#if data.event.capacity}<span
					><Ticket size={17} />Limited to {data.event.capacity} guests</span
				>{/if}
		</div>
	</section>
	<div class="event-columns">
		<section class="registration-card" aria-labelledby="registration-heading">
			<h2 id="registration-heading">
				{phase === 'done'
					? 'You’re on the list.'
					: phase === 'pending'
						? 'Confirming your tickets.'
						: 'Save your place.'}
			</h2>
			{#if phase === 'done'}<p role="status">{message}</p>
			{:else if phase === 'pending'}<p role="status">{message}</p>
				<button type="button" class="secondary" onclick={pollStatus}>Check confirmation</button>
			{:else if phase === 'payment'}<p>
					Complete secure payment for {money(
						selectedTicket.priceMinor * quantity,
						selectedTicket.currency
					)}.
				</p>
				<div bind:this={paymentMount} class="payment-element"></div>
				<button class="primary" type="button" disabled={busy} onclick={pay}
					>{busy ? 'Confirming…' : 'Pay securely'}</button
				>
			{:else}<form
					onsubmit={(event) => {
						event.preventDefault();
						void register();
					}}
				>
					<label
						>Ticket or RSVP<select bind:value={ticketTypeId} required disabled={!ready || busy}
							>{#each data.tickets as ticket}<option
									value={ticket.id}
									disabled={ticket.capacity !== null && ticket.reserved >= ticket.capacity}
									>{ticket.name} · {Number(ticket.priceMinor)
										? money(Number(ticket.priceMinor), ticket.currency)
										: 'Free RSVP'}{ticket.capacity !== null
										? ` · ${Math.max(0, ticket.capacity - ticket.reserved)} left`
										: ''}</option
								>{/each}</select
						></label
					>
					<label
						>Number of guests<input
							type="number"
							bind:value={quantity}
							disabled={!ready || busy}
							min="1"
							max="12"
							required
						/></label
					>
					<label
						>Your name<input
							name="name"
							autocomplete="name"
							bind:value={fullName}
							disabled={!ready || busy}
							required
							maxlength="120"
						/></label
					>
					<label
						>Email address<input
							name="email"
							type="email"
							autocomplete="email"
							bind:value={email}
							disabled={!ready || busy}
							required
							maxlength="254"
						/></label
					>
					<button class="primary" type="submit" disabled={!ready || busy || !ticketTypeId}
						>{busy ? 'Saving your place…' : 'Register'}</button
					>
				</form>{/if}
			{#if message && phase !== 'done' && phase !== 'pending'}<p class="feedback" role="alert">
					{message}
				</p>{/if}
		</section>
		<aside class="event-aside">
			<h2>Come be part of it.</h2>
			<p>
				Hosted by {data.organization}. We’ll use your information only to coordinate this event.
			</p>
			{#if data.sponsors?.length}<div class="supporters">
					<h3>With thanks to</h3>
					{#each data.sponsors as sponsor}<p>
							{sponsor.organizationName}<span>{sponsor.tier}</span>
						</p>{/each}
				</div>{/if}
		</aside>
	</div>
	{#if data.volunteerOpportunities?.length}<section class="volunteer-section">
			<p class="eyebrow">LEND A HAND</p>
			<h2>Volunteer opportunities</h2>
			<div class="volunteer-grid">
				{#each data.volunteerOpportunities as opportunity}<article>
						<h3><HeartHandshake size={18} />{opportunity.name}</h3>
						<p>{opportunity.description}</p>
						<p class="muted">
							{Number(opportunity.reserved)} of {opportunity.capacity} spots filled
						</p>
						<form
							data-volunteer={opportunity.id}
							onsubmit={(event) => {
								event.preventDefault();
								void signUp(opportunity.id);
							}}
						>
							<label>Your name<input name="name" required maxlength="120" /></label><label
								>Email address<input name="email" type="email" required maxlength="254" /></label
							><button
								class="secondary"
								type="submit"
								disabled={Number(opportunity.reserved) >= opportunity.capacity}>Volunteer</button
							>
						</form>
					</article>{/each}
			</div>
		</section>{/if}
	<footer>Donor CRM · Secure event registration</footer>
</main>

<style>
	.public-event {
		max-width: 1100px;
		margin: 0 auto;
		padding: clamp(1rem, 4vw, 3rem);
		color: var(--ink);
		min-height: 100vh;
	}
	.public-event header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		border-bottom: 1px solid var(--line);
		padding-bottom: 1rem;
	}
	.brand {
		display: flex;
		align-items: center;
		gap: 0.65rem;
		font-weight: 600;
	}
	.brand img {
		width: 34px;
	}
	.eyebrow {
		font-size: 0.68rem;
		letter-spacing: 0.13em;
		color: var(--muted);
		text-transform: uppercase;
	}
	.event-intro {
		max-width: 760px;
		padding: clamp(2.5rem, 8vw, 6rem) 0 2rem;
	}
	.event-intro h1 {
		margin: 0.65rem 0 1.1rem;
	}
	.event-description {
		font-size: 1.08rem;
		max-width: 42rem;
	}
	.event-meta {
		display: flex;
		gap: 1.4rem;
		flex-wrap: wrap;
		margin-top: 1.7rem;
		color: var(--muted);
	}
	.event-meta span {
		display: flex;
		gap: 0.45rem;
		align-items: center;
	}
	.event-columns {
		display: grid;
		grid-template-columns: minmax(0, 1.2fr) minmax(250px, 0.8fr);
		gap: 2rem;
		align-items: start;
	}
	.registration-card,
	.event-aside,
	.volunteer-grid article {
		border: 1px solid var(--line);
		background: var(--white);
		padding: clamp(1rem, 3vw, 2rem);
	}
	.registration-card h2,
	.event-aside h2 {
		margin-bottom: 1rem;
	}
	.registration-card form,
	.volunteer-grid form {
		display: grid;
		gap: 0.85rem;
		margin-top: 1.25rem;
	}
	.registration-card label,
	.volunteer-grid label {
		display: grid;
		gap: 0.35rem;
		font-size: 0.82rem;
		color: var(--muted);
	}
	.registration-card input,
	.registration-card select,
	.volunteer-grid input {
		width: 100%;
		border: 1px solid var(--line);
		background: var(--paper);
		color: var(--ink);
		padding: 0.75rem;
		min-height: 44px;
	}
	.primary,
	.secondary {
		min-height: 44px;
		padding: 0.7rem 1rem;
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
	button:disabled {
		opacity: 0.55;
	}
	.supporters {
		margin-top: 2rem;
	}
	.supporters h3 {
		font-size: 0.9rem;
		margin-bottom: 0.7rem;
	}
	.supporters p {
		display: flex;
		justify-content: space-between;
		gap: 1rem;
		padding: 0.6rem 0;
		border-bottom: 1px solid var(--line);
	}
	.supporters span,
	.muted {
		color: var(--muted);
		font-size: 0.82rem;
	}
	.volunteer-section {
		padding: 3rem 0;
	}
	.volunteer-section h2 {
		margin: 0.4rem 0 1rem;
	}
	.volunteer-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(min(100%, 300px), 1fr));
		gap: 1rem;
	}
	.volunteer-grid h3 {
		display: flex;
		align-items: center;
		gap: 0.4rem;
	}
	.volunteer-grid article > p {
		margin: 0.5rem 0;
	}
	.feedback {
		margin-top: 1rem;
		color: var(--coral);
	}
	.payment-element {
		padding: 1rem 0;
	}
	.public-event footer {
		padding: 3rem 0 1rem;
		text-align: center;
		color: var(--muted);
		font-size: 0.75rem;
	}
	@media (max-width: 720px) {
		.event-columns {
			grid-template-columns: 1fr;
		}
		.event-intro {
			padding: 2.5rem 0 1.5rem;
		}
		.event-meta {
			display: grid;
			gap: 0.7rem;
		}
		.public-event header .eyebrow {
			font-size: 0.57rem;
		}
	}
</style>
