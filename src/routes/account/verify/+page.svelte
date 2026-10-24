<script lang="ts">
	import { untrack } from 'svelte';
	let { data } = $props<{ data: { token: string; tenant: string } }>();
	let email = $state(''),
		tenant = $state(untrack(() => data.tenant)),
		message = $state(''),
		error = $state(''),
		busy = $state(false);
	async function act() {
		busy = true;
		error = '';
		message = '';
		try {
			const endpoint = data.token
				? '/api/v1/identity/verification/consume'
				: '/api/v1/identity/verification/request';
			const body = data.token ? { token: data.token } : { email, tenant };
			const res = await fetch(endpoint, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body)
			});
			const result = await res.json();
			if (!res.ok) throw new Error(result.error || 'Request failed');
			message = data.token
				? 'Email confirmed. You can now sign in.'
				: 'If that account needs confirmation, a verification message has been queued for delivery.';
		} catch (e) {
			error = e instanceof Error ? e.message : 'Request failed';
		} finally {
			busy = false;
		}
	}
</script>

<svelte:head><title>Confirm email · Donor CRM</title></svelte:head>
<main class="auth-page">
	<a class="brand" href="/">Donor CRM</a>
	<div class="auth-content">
		<span class="eyebrow">ACCOUNT SECURITY</span>
		<h1>Confirm your email<span class="heading-dot">.</span></h1>
		{#if data.token}<p class="lede">Confirm this address to finish setting up your workspace.</p>
			<button class="primary" onclick={act} disabled={busy}
				>{busy ? 'Confirming…' : 'Confirm email ↗'}</button
			>
		{:else}<p class="lede">
				Request a fresh confirmation link. We’ll show the same response either way.
			</p>
			<form
				class="stacked-form"
				onsubmit={(e) => {
					e.preventDefault();
					act();
				}}
			>
				<label>Email<input type="email" autocomplete="email" required bind:value={email} /></label
				><label>Workspace slug<input required bind:value={tenant} /></label><button
					class="primary"
					disabled={busy}>{busy ? 'Requesting…' : 'Send confirmation link ↗'}</button
				>
			</form>{/if}
		{#if message}<p class="banner">{message}</p>{/if}{#if error}<p
				class="banner error"
				role="alert"
			>
				{error}
			</p>{/if}
		<p class="auth-links"><a href="/login">Return to sign in</a></p>
	</div>
</main>
