<script lang="ts">
	import { onMount } from 'svelte';
	let { demo = false } = $props<{ demo?: boolean }>();
	type Step = { id: string; title: string; done: boolean; href: string; detail: string };
	let steps = $state<Step[]>([]),
		completed = $state(0),
		total = $state(0),
		loading = $state(true),
		error = $state('');
	async function load() {
		if (demo) {
			steps = [];
			loading = false;
			return;
		}
		loading = true;
		error = '';
		try {
			const response = await fetch('/api/v1/onboarding');
			const data = await response.json();
			if (!response.ok) throw new Error(data.error || 'Workspace setup could not be loaded.');
			steps = data.onboarding.steps;
			completed = data.onboarding.completed;
			total = data.onboarding.total;
		} catch (e) {
			error = e instanceof Error ? e.message : 'Workspace setup could not be loaded.';
		} finally {
			loading = false;
		}
	}
	onMount(() => {
		void load();
	});
</script>

<section class="onboarding" aria-labelledby="onboarding-title">
	<header>
		<div>
			<p class="eyebrow">FIRST STEPS</p>
			<h2 id="onboarding-title">Get your workspace ready</h2>
			<p>Each item reflects saved workspace configuration and real records.</p>
		</div>
		{#if !loading && !error && !demo}<strong
				class="progress"
				aria-label={`${completed} of ${total} setup tasks completed`}
				>{completed}<span> / {total}</span></strong
			>{/if}
	</header>
	{#if demo}<p class="empty">
			Setup progress is available after you sign in to a persistent workspace.
		</p>
	{:else if loading}<p class="empty" role="status">Checking workspace setup…</p>
	{:else if error}<p class="error" role="alert">
			{error} <button type="button" onclick={load}>Retry</button>
		</p>
	{:else}<ol>
			{#each steps as step (step.id)}<li class:complete={step.done}>
					<span class="mark" aria-hidden="true"
						>{step.done ? '✓' : String(steps.indexOf(step) + 1)}</span
					>
					<div><strong>{step.title}</strong><small>{step.detail}</small></div>
					<a href={step.href}>{step.done ? 'Review' : 'Set up'} <span aria-hidden="true">↗</span></a
					>
				</li>{/each}
		</ol>{/if}
</section>

<style>
	.onboarding {
		display: grid;
		gap: 0.9rem;
		border-top: 1px solid var(--border, #dce4df);
		padding: 1.2rem 0;
	}
	.onboarding header {
		display: flex;
		justify-content: space-between;
		align-items: flex-start;
		gap: 1rem;
	}
	.eyebrow {
		font-size: 0.7rem;
		letter-spacing: 0.12em;
		color: var(--muted, #60766d);
		margin: 0;
	}
	.onboarding h2 {
		margin: 0.15rem 0;
	}
	.onboarding header p,
	.onboarding small,
	.empty {
		color: var(--muted, #66736c);
	}
	.progress {
		font-variant-numeric: tabular-nums;
		font-size: 1.15rem;
	}
	.progress span {
		font-size: 0.9rem;
		color: var(--muted, #66736c);
	}
	ol {
		list-style: none;
		padding: 0;
		margin: 0;
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr));
		gap: 0.35rem 1.5rem;
	}
	li {
		display: grid;
		grid-template-columns: 1.7rem 1fr auto;
		align-items: center;
		gap: 0.6rem;
		padding: 0.75rem 0;
		border-bottom: 1px solid var(--border, #e0e7e3);
	}
	li > div {
		display: grid;
		gap: 0.2rem;
	}
	.mark {
		display: grid;
		place-items: center;
		width: 1.45rem;
		height: 1.45rem;
		border: 1px solid var(--border, #b9c8c0);
		border-radius: 50%;
		font-size: 0.75rem;
	}
	.complete .mark {
		background: #e5f2e8;
		color: #28613e;
		border-color: #acd1b7;
	}
	li a {
		color: var(--color-primary, #2c6049);
		text-decoration: none;
		font-weight: 600;
		white-space: nowrap;
	}
	.error {
		color: #902e1e;
	}
	.error button {
		margin-left: 0.5rem;
	}
</style>
