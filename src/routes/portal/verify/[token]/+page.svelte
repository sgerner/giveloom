<script lang="ts">
	import { onMount } from 'svelte';
	let { data } = $props();
	let ready = $state(false);
	let busy = $state(false);
	let error = $state('');
	onMount(() => {
		ready = true;
	});
	async function verify() {
		busy = true;
		error = '';
		try {
			const response = await fetch('/api/v1/portal/auth/verify', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ token: data.token })
			});
			const result = await response.json();
			if (!response.ok) throw new Error(result.error || 'This sign-in link is invalid or expired.');
			location.assign('/portal');
		} catch (e) {
			error = e instanceof Error ? e.message : 'Sign-in could not be completed.';
		} finally {
			busy = false;
		}
	}
</script>

<svelte:head
	><title>Confirm sign-in · Donor CRM</title><meta
		name="robots"
		content="noindex,nofollow"
	/></svelte:head
>
<main>
	<a class="brand" href="/">Donor CRM</a>
	<section>
		<p class="eyebrow">DONOR PORTAL</p>
		<h1>Confirm your sign-in</h1>
		<p>This one-time sign-in link expires shortly and can only be used once.</p>
		<button onclick={verify} disabled={!ready || busy}
			>{busy ? 'Signing in…' : 'Continue to your portal'}</button
		>{#if error}<p class="error" role="alert">{error}</p>{/if}
	</section>
</main>

<style>
	main {
		max-width: 560px;
		margin: 0 auto;
		padding: 48px 24px;
		color: #17231f;
	}
	.brand {
		font-size: 1.2rem;
		font-weight: 800;
		color: #176b52;
		text-decoration: none;
	}
	section {
		margin-top: 96px;
		border: 1px solid #e3e9e5;
		border-radius: 20px;
		padding: 32px;
		background: white;
	}
	h1 {
		font-size: 2.6rem;
		letter-spacing: -0.055em;
		line-height: 1.05;
		margin: 0.4rem 0 1rem;
	}
	.eyebrow {
		font-size: 0.7rem;
		font-weight: 800;
		letter-spacing: 0.14em;
		color: #397c65;
	}
	p {
		line-height: 1.6;
		color: #728078;
	}
	button {
		border: 0;
		border-radius: 10px;
		background: #176b52;
		color: white;
		padding: 13px 18px;
		font: inherit;
		font-weight: 700;
		cursor: pointer;
	}
	.error {
		background: #fff1ef;
		color: #a33e30;
		padding: 12px;
		border-radius: 10px;
	}
</style>
