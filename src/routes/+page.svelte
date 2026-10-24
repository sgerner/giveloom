<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	let { data } = $props();
	let ready = $state(false);
	onMount(() => {
		ready = true;
	});
	let pending = $state(false);
	let error = $state('');
	async function enter() {
		pending = true;
		error = '';
		try {
			const response = await fetch('/api/v1/demo', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ tenant: 'riverstone' })
			});
			if (!response.ok) throw new Error('Demo is unavailable. Check the server configuration.');
			await goto('/app/riverstone/overview');
		} catch (e) {
			error = e instanceof Error ? e.message : 'Could not sign in';
		} finally {
			pending = false;
		}
	}
</script>

<svelte:head
	><title>Donor CRM — Good grows through connection</title><meta
		name="description"
		content="A thoughtful home for your people, purpose, and possibility."
	/></svelte:head
>
<main class="welcome">
	<div class="welcome-header">
		<a class="brand" href="/"
			><img src="/brand/generous-dots.svg" alt="" width="40" height="40" /> Donor CRM</a
		><a class="secondary" href={`${data.realAppUrl || ''}/login`}>Sign in ↗</a>
	</div>
	<div class="welcome-content">
		<span class="eyebrow">A little connection. A lasting difference.</span>
		<h1>Good grows<br />between <em>people.</em></h1>
		<p>
			A thoughtful home for your donors, your next big idea, and all the good you’re here to do.
		</p>
		{#if data.demoUrl}
			<a class="primary" href={`${data.demoUrl}/demo/start`}>Explore the demo <span>↗</span></a>
		{:else if data.demoAvailable}
			<button class="primary" onclick={enter} disabled={pending || !ready}
				>{pending ? 'Opening your workspace…' : 'Explore the demo'} <span>↗</span></button
			>
		{/if}
		<a class="secondary" href={`${data.realAppUrl || ''}/signup`}
			>Create your workspace <span>↗</span></a
		>
		{#if data.demoAvailable || data.demoUrl}<p class="muted small">
				Riverstone Community Fund · Synthetic demonstration<br />No live payments, emails, or paid
				AI calls.
			</p>{/if}
		{#if error}<p role="alert" class="error">{error}</p>{/if}
	</div>
	<div class="welcome-art" aria-hidden="true">
		<div class="orbit o1"></div>
		<div class="orbit o2"></div>
		<div class="art-center">Together,<br /><em>further.</em></div>
		<span class="art-dot d1">✳</span><span class="art-dot d2">↗</span><span class="art-dot d3"
			>♡</span
		>
	</div>
	<footer>Built around the relationships that matter.</footer>
</main>
