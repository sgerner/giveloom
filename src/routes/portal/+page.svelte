<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { formatMoney } from '$lib/money';
	let { data } = $props();
	let email = $state('');
	let tenant = $state(untrack(() => data.tenant || ''));
	let ready = $state(false);
	let message = $state('');
	let error = $state('');
	let busy = $state(false);
	let receiptEmails = $state(true);
	let newsletterOptIn = $state(false);
	let responseNote = $state(''),
		respondingId = $state('');
	let profileName = $state('');
	let hasAddress = $state(false);
	let profileAddress = $state({
		line1: '',
		line2: '',
		city: '',
		region: '',
		postalCode: '',
		country: 'US'
	});
	onMount(() => {
		ready = true;
	});
	$effect(() => {
		receiptEmails = data.portal?.preferences.receiptEmails ?? true;
		newsletterOptIn = data.portal?.preferences.newsletterOptIn ?? false;
		profileName = data.portal?.contact.name ?? '';
		if (data.portal?.address) {
			profileAddress = { ...data.portal.address, line2: data.portal.address.line2 || '' };
			hasAddress = true;
		}
	});
	let saved = $state('');
	const money = (minor: number, currency: string) => formatMoney(minor, currency);
	async function requestLink() {
		busy = true;
		message = '';
		error = '';
		try {
			const r = await fetch('/api/v1/portal/auth/request', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ tenant, email })
			});
			const body = await r.json();
			if (!r.ok) throw new Error(body.error || 'Could not request a sign-in link.');
			message = body.message;
		} catch (e) {
			error = e instanceof Error ? e.message : 'Could not request a sign-in link.';
		} finally {
			busy = false;
		}
	}
	async function savePreferences() {
		saved = '';
		error = '';
		try {
			const r = await fetch('/api/v1/portal/preferences', {
				method: 'PATCH',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ receiptEmails, newsletterOptIn })
			});
			const body = await r.json();
			if (!r.ok) throw new Error(body.error || 'Preferences could not be saved.');
			saved = 'Your preferences are saved.';
		} catch (e) {
			error = e instanceof Error ? e.message : 'Preferences could not be saved.';
		}
	}
	async function billing() {
		error = '';
		try {
			const r = await fetch('/api/v1/portal/billing', { method: 'POST' });
			const body = await r.json();
			if (!r.ok) throw new Error(body.error || 'Billing management is unavailable.');
			location.assign(body.url);
		} catch (e) {
			error = e instanceof Error ? e.message : 'Billing management is unavailable.';
		}
	}
	async function saveProfile() {
		error = '';
		saved = '';
		try {
			const r = await fetch('/api/v1/portal/profile', {
				method: 'PATCH',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ name: profileName, address: hasAddress ? profileAddress : null })
			});
			const body = await r.json();
			if (!r.ok) throw new Error(body.error || 'Profile could not be saved.');
			saved = 'Your profile is saved.';
		} catch (e) {
			error = e instanceof Error ? e.message : 'Profile could not be saved.';
		}
	}
	async function respond(intro: any, answer: 'yes' | 'no' | 'unsure') {
		error = '';
		message = '';
		respondingId = intro.id;
		try {
			const r = await fetch(
				`/api/v1/portal/introductions/${encodeURIComponent(intro.id)}/response`,
				{
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ answer, note: responseNote })
				}
			);
			const result = await r.json();
			if (!r.ok) throw new Error(result.error || 'Your response could not be saved.');
			message =
				answer === 'yes'
					? 'Thank you. Your consent is recorded; the organization can prepare a draft for you to review.'
					: 'Your answer is recorded. No introduction will be prepared.';
			responseNote = '';
			location.reload();
		} catch (e) {
			error = e instanceof Error ? e.message : 'Your response could not be saved.';
		} finally {
			respondingId = '';
		}
	}
	async function logout() {
		await fetch('/api/v1/portal/session', { method: 'DELETE' });
		location.assign('/portal');
	}
</script>

<svelte:head
	><title>Donor portal · Donor CRM</title><meta
		name="robots"
		content="noindex,nofollow"
	/></svelte:head
>
<main class="shell">
	<a
		class="brand"
		href="/"
		aria-label={data.branding?.publicName || data.portal?.organization || 'Donor CRM'}
		>{#if data.branding?.logoUrl}<img
				src={data.branding.logoUrl}
				alt=""
				width="34"
				height="34"
			/>{/if}{data.branding?.publicName || data.portal?.organization || 'Donor CRM'}</a
	>
	{#if !data.available}
		<section class="card">
			<p class="eyebrow">DONOR PORTAL</p>
			<h1>Online portal sign-in is unavailable</h1>
			<p class="muted">This portal requires the production database and email service.</p>
		</section>
	{:else if !data.portal}
		<section class="card login">
			<p class="eyebrow">DONOR PORTAL</p>
			<h1>Your giving, in one place.</h1>
			<p class="muted">
				Enter the email address used for your donations. We’ll send a secure, one-time sign-in link
				if an account matches.
			</p>
			<form
				onsubmit={(event) => {
					event.preventDefault();
					requestLink();
				}}
			>
				<label
					>Organization workspace<input
						bind:value={tenant}
						disabled={!ready || busy}
						required
						autocomplete="organization"
						placeholder="organization-slug"
					/></label
				>
				<label
					>Email address<input
						bind:value={email}
						disabled={!ready || busy}
						type="email"
						required
						autocomplete="email"
					/></label
				>
				<button disabled={!ready || busy}>{busy ? 'Sending…' : 'Email me a sign-in link'}</button>
			</form>
			{#if message}<p class="notice" role="status">{message}</p>{/if}{#if error}<p
					class="error"
					role="alert"
				>
					{error}
				</p>{/if}
		</section>
	{:else}
		<header class="welcome">
			<div>
				<p class="eyebrow">DONOR PORTAL</p>
				<h1>Hello, {data.portal.contact.name.split(' ')[0]}.</h1>
				<p class="muted">Your giving history with {data.portal.organization}.</p>
			</div>
			<button class="quiet" onclick={logout}>Sign out</button>
		</header>
		{#if error}<p class="error" role="alert">{error}</p>{/if}
		{#if data.portal.tenantSuspended}<p class="notice" role="status">
				This organization workspace is suspended. Your existing donation history and acknowledgments
				remain available, while profile, preference, introduction, and recurring-gift changes are
				paused.
			</p>{/if}
		{#if data.portal.introductions?.length}<section class="card intro-asks">
				<div class="section-head">
					<div>
						<p class="eyebrow">A PERSONAL REQUEST</p>
						<h2>Would you like to make an introduction?</h2>
					</div>
					<span class="count">{data.portal.introductions.length}</span>
				</div>
				{#each data.portal.introductions as intro}<article>
						<div>
							<h3>
								{intro.title || `A connection to ${intro.prospectName || 'a community partner'}`}
							</h3>
							<p>
								The fundraising team believes you may be able to introduce {intro.prospectName ||
									'this candidate'}. Please respond only if you personally know them and are
								comfortable making an introduction.
							</p>
						</div>
						{#if data.portal.tenantSuspended}<p class="muted">
								Responses are paused while this organization workspace is suspended.
							</p>{:else}<label
								>Optional note to your organization<textarea
									rows="2"
									bind:value={responseNote}
									placeholder="Anything you would like the team to know"></textarea></label
							>
							<div class="ask-actions">
								<button disabled={respondingId === intro.id} onclick={() => respond(intro, 'yes')}
									>Yes, I’m willing to introduce</button
								><button
									class="secondary"
									disabled={respondingId === intro.id}
									onclick={() => respond(intro, 'unsure')}>I’m unsure</button
								><button
									class="quiet"
									disabled={respondingId === intro.id}
									onclick={() => respond(intro, 'no')}>No, thanks</button
								>
							</div>{/if}
					</article>{/each}
			</section>{/if}
		<section class="card">
			<div class="section-head">
				<div>
					<p class="eyebrow">PROFILE</p>
					<h2>Your details</h2>
				</div>
			</div>
			{#if data.portal.tenantSuspended}<p class="muted">
					Profile updates are paused while this organization workspace is suspended.
				</p>{/if}
			<form
				class="profile-form"
				onsubmit={(event) => {
					event.preventDefault();
					saveProfile();
				}}
			>
				<fieldset disabled={Boolean(data.portal.tenantSuspended)}>
					<label
						>Name<input
							autocomplete="name"
							required
							minlength="2"
							maxlength="120"
							bind:value={profileName}
						/></label
					>
					<label class="check"
						><input type="checkbox" bind:checked={hasAddress} />Save a mailing address</label
					>
					{#if hasAddress}<div class="profile-address">
							<label
								>Street address<input
									autocomplete="address-line1"
									required
									bind:value={profileAddress.line1}
								/></label
							><label
								>Apartment or unit<input
									autocomplete="address-line2"
									bind:value={profileAddress.line2}
								/></label
							><label
								>City<input
									autocomplete="address-level2"
									required
									bind:value={profileAddress.city}
								/></label
							><label
								>State or region<input
									autocomplete="address-level1"
									required
									bind:value={profileAddress.region}
								/></label
							><label
								>Postal code<input
									autocomplete="postal-code"
									required
									bind:value={profileAddress.postalCode}
								/></label
							><label
								>Country code<input
									autocomplete="country"
									required
									minlength="2"
									maxlength="2"
									pattern="[A-Za-z]{2}"
									bind:value={profileAddress.country}
								/></label
							>
						</div>{/if}
					{#if !data.portal.tenantSuspended}<div class="actions">
							<button class="secondary" type="submit">Save profile</button>
						</div>{/if}
				</fieldset>
			</form>
		</section>
		<section class="card">
			<div class="section-head">
				<div>
					<p class="eyebrow">GIVING HISTORY</p>
					<h2>Your donations</h2>
				</div>
				<span class="count">{data.portal.gifts.length}</span>
			</div>
			{#if data.portal.gifts.length}
				<div class="gift-list">
					{#each data.portal.gifts as gift (gift.id)}
						<article class="gift">
							<div>
								<strong>{money(gift.amountMinor, gift.currency)}</strong>
								<p>
									{gift.campaignName ||
										(gift.kind === 'recurring' ? 'Recurring donation' : 'Donation')} · {new Date(
										gift.occurredAt
									).toLocaleDateString()}
								</p>
							</div>
							<div class="gift-right">
								<span class:refunded={gift.status === 'refunded'}
									>{gift.status.replaceAll('_', ' ')}</span
								>{#if !gift.correctionOf && gift.status === 'recorded'}<a
										href={`/portal/receipt/${gift.id}`}>Acknowledgment</a
									>{/if}
							</div>
						</article>
					{/each}
				</div>
			{:else}<p class="muted empty">No donations are linked to this portal yet.</p>{/if}
		</section>
		<section class="card">
			<div class="section-head">
				<div>
					<p class="eyebrow">EVENTS</p>
					<h2>Your tickets and registrations</h2>
				</div>
				<span class="count">{data.portal.tickets.length}</span>
			</div>
			{#if data.portal.tickets.length}<div class="gift-list">
					{#each data.portal.tickets as ticket (ticket.id)}<article class="gift">
							<div>
								<strong>{ticket.eventName}</strong>
								<p>
									{ticket.ticketName} · {ticket.quantity}
									{ticket.quantity === 1 ? 'ticket' : 'tickets'} · {new Date(
										ticket.startsAt
									).toLocaleDateString()}
								</p>
							</div>
							<div class="gift-right">
								<span>{ticket.status.replaceAll('_', ' ')}</span>{#if ticket.amountMinor > 0}<small
										>{money(ticket.amountMinor, ticket.currency)}</small
									>{/if}
							</div>
						</article>{/each}
				</div>{:else}<p class="muted empty">
					No event registrations are linked to this portal yet.
				</p>{/if}
		</section>
		<section class="card">
			<div class="section-head">
				<div>
					<p class="eyebrow">PREFERENCES</p>
					<h2>Email settings</h2>
				</div>
			</div>
			{#if data.portal.tenantSuspended}<p class="muted">
					Your saved email preferences remain in place while this organization workspace is
					suspended.
				</p>{:else}<label class="check"
					><input type="checkbox" bind:checked={receiptEmails} /> Email me donation receipts and acknowledgments</label
				>
				<label class="check"
					><input type="checkbox" bind:checked={newsletterOptIn} /> Send me occasional organization updates</label
				>
				<div class="actions">
					<button class="secondary" onclick={savePreferences}>Save preferences</button><button
						class="quiet"
						onclick={billing}>Manage recurring donations</button
					>
				</div>
			{/if}
			{#if saved}<p class="notice" role="status">{saved}</p>{/if}
		</section>
		<p class="footer">
			Signed in as {data.portal.contact.email}. Donation acknowledgments are not tax advice.
		</p>
	{/if}
</main>

<style>
	.shell {
		max-width: 760px;
		margin: 0 auto;
		padding: 48px 24px 80px;
		color: #17231f;
	}
	.brand {
		display: inline-flex;
		align-items: center;
		gap: 0.65rem;
		font-weight: 800;
		color: #176b52;
		text-decoration: none;
		letter-spacing: -0.04em;
		font-size: 1.2rem;
	}
	.brand img {
		width: 34px;
		height: 34px;
		object-fit: contain;
	}
	.card {
		background: white;
		border: 1px solid #e3e9e5;
		border-radius: 20px;
		padding: 30px;
		margin-top: 24px;
		box-shadow: 0 12px 38px #213b2d0a;
	}
	.login {
		max-width: 480px;
		margin: 70px auto 0;
	}
	h1 {
		font-size: clamp(2rem, 5vw, 3.2rem);
		letter-spacing: -0.055em;
		line-height: 1.05;
		margin: 0.3rem 0 0.8rem;
	}
	h2 {
		font-size: 1.35rem;
		letter-spacing: -0.03em;
		margin: 0;
	}
	.eyebrow {
		font-size: 0.7rem;
		font-weight: 800;
		letter-spacing: 0.14em;
		color: #397c65;
		margin: 0 0 8px;
	}
	.muted,
	.footer {
		color: #728078;
		line-height: 1.6;
	}
	.login form {
		display: grid;
		gap: 16px;
		margin-top: 28px;
	}
	label {
		display: grid;
		gap: 8px;
		font-size: 0.86rem;
		font-weight: 650;
	}
	.profile-form {
		display: grid;
		gap: 14px;
	}
	.profile-address {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 14px;
		margin: 14px 0;
	}
	@media (max-width: 520px) {
		.profile-address {
			grid-template-columns: 1fr;
		}
	}
	input:not([type='checkbox']) {
		width: 100%;
		border: 1px solid #d6dfd9;
		border-radius: 10px;
		padding: 12px 14px;
		font: inherit;
		background: #fff;
		color: #17231f;
	}
	button {
		border: 0;
		border-radius: 10px;
		background: #176b52;
		color: #fff;
		padding: 12px 17px;
		font: inherit;
		font-weight: 700;
		cursor: pointer;
	}
	button:disabled {
		opacity: 0.6;
		cursor: wait;
	}
	.notice {
		background: #edf8f1;
		color: #216b43;
		padding: 12px 14px;
		border-radius: 10px;
		font-size: 0.9rem;
	}
	.error {
		background: #fff1ef;
		color: #a33e30;
		padding: 12px 14px;
		border-radius: 10px;
	}
	.intro-asks article {
		padding: 18px 0;
		border-top: 1px solid var(--line, #dce3dd);
		display: grid;
		gap: 12px;
	}
	.intro-asks h3 {
		font:
			21px Georgia,
			serif;
		margin: 0 0 7px;
	}
	.intro-asks article p {
		font-size: 12px;
		color: var(--muted, #66736c);
		line-height: 1.55;
		margin: 0;
	}
	.intro-asks label {
		font-size: 11px;
		display: grid;
		gap: 7px;
	}
	.intro-asks textarea {
		font: inherit;
		padding: 9px;
		border: 1px solid var(--line, #dce3dd);
		background: var(--surface, #fff);
		color: var(--ink, #17251f);
	}
	.ask-actions {
		display: flex;
		align-items: center;
		gap: 10px;
		flex-wrap: wrap;
	}
	.ask-actions button {
		border: 0;
		background: #315d48;
		color: white;
		padding: 10px 13px;
		cursor: pointer;
		font: inherit;
		font-size: 11px;
	}
	.ask-actions .secondary {
		background: transparent;
		color: inherit;
		border: 1px solid var(--line, #dce3dd);
	}
	.ask-actions .quiet {
		background: transparent;
		color: var(--muted, #66736c);
		text-decoration: underline;
	}
	.welcome {
		display: flex;
		justify-content: space-between;
		align-items: flex-start;
		margin-top: 66px;
	}
	.quiet {
		background: transparent;
		color: #51665b;
		padding: 10px;
	}
	.section-head {
		display: flex;
		justify-content: space-between;
		align-items: center;
		margin-bottom: 16px;
	}
	.count {
		background: #edf5f0;
		border-radius: 99px;
		padding: 6px 12px;
		color: #397c65;
		font-weight: 750;
	}
	.gift-list {
		display: grid;
	}
	.gift {
		padding: 16px 0;
		border-top: 1px solid #edf0ee;
		display: flex;
		justify-content: space-between;
		gap: 20px;
	}
	.gift strong {
		font-size: 1.05rem;
	}
	.gift p {
		font-size: 0.84rem;
		color: #728078;
		margin: 5px 0 0;
	}
	.gift-right {
		display: grid;
		justify-items: end;
		align-content: center;
		gap: 7px;
		color: #597367;
		text-transform: capitalize;
		font-size: 0.78rem;
	}
	.gift-right a {
		color: #176b52;
		font-weight: 700;
	}
	.refunded {
		color: #a35a35;
	}
	.empty {
		margin-bottom: 0;
	}
	.check {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 11px 0;
		font-weight: 500;
	}
	.check input {
		accent-color: #176b52;
		width: 16px;
		height: 16px;
	}
	.actions {
		display: flex;
		gap: 10px;
		align-items: center;
		flex-wrap: wrap;
		margin-top: 16px;
	}
	.secondary {
		background: #eaf3ee;
		color: #176b52;
	}
	.footer {
		text-align: center;
		font-size: 0.8rem;
		margin-top: 24px;
	}
	@media (max-width: 520px) {
		.shell {
			padding: 28px 16px 56px;
		}
		.card {
			padding: 22px;
		}
		.welcome {
			margin-top: 48px;
		}
		.gift {
			gap: 10px;
		}
		.gift-right {
			font-size: 0.7rem;
		}
	}
</style>
