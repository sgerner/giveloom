<script lang="ts">
	import { onMount } from 'svelte';
	export let tenant = '';
	export let automationId = '';
	let automations: any[] = [];
	let selected = automationId;
	let runs: any[] = [];
	let selectedRun: any = null;
	let steps: any[] = [];
	let error = '';
	let busy = false;
	let timer: any;
	async function load() {
		try {
			const a = await fetch('/api/v1/automations').then((r) => r.json());
			automations = a.automations ?? [];
			if (!selected) selected = automationId || automations[0]?.id || '';
			if (selected) {
				const data = await fetch(`/api/v1/automations/${selected}/runs`).then((r) => r.json());
				if (data.error) throw new Error(data.error);
				runs = data.runs ?? [];
				if (selectedRun) {
					const detail = await fetch(`/api/v1/automation-runs/${selectedRun}`).then((r) =>
						r.json()
					);
					steps = detail.steps ?? [];
				}
			}
		} catch (e) {
			error = e instanceof Error ? e.message : 'Run history unavailable.';
		}
	}
	async function inspect(id: string) {
		selectedRun = id;
		const response = await fetch(`/api/v1/automation-runs/${id}`);
		const data = await response.json();
		if (!response.ok) {
			error = data.error || 'Run detail unavailable.';
			return;
		}
		steps = data.steps ?? [];
	}
	async function update(id: string, action: string) {
		busy = true;
		error = '';
		try {
			const response = await fetch(`/api/v1/automation-runs/${id}`, {
				method: 'PATCH',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ action })
			});
			const data = await response.json();
			if (!response.ok) throw new Error(data.error || 'Run update failed.');
			await load();
		} catch (e) {
			error = e instanceof Error ? e.message : 'Run update failed.';
		} finally {
			busy = false;
		}
	}
	onMount(() => {
		load();
		timer = setInterval(load, 10000);
		return () => clearInterval(timer);
	});
</script>

<section class="monitor" aria-labelledby="job-title">
	<header>
		<div>
			<p class="eyebrow">Durable execution</p>
			<h2 id="job-title">Workflow run history</h2>
			<p>Runs record completed steps and expose failed work for safe retry.</p>
		</div>
		<label
			>Workflow in {tenant}<select bind:value={selected} on:change={load}
				><option value="">Choose workflow</option>{#each automations as a}<option value={a.id}
						>{a.name}</option
					>{/each}</select
			></label
		>
	</header>
	{#if error}<p role="alert">{error}</p>{/if}
	<div class="runs">
		{#if runs.length}{#each runs as run}<article class:selected={selectedRun === run.id}>
					<button class="run" type="button" on:click={() => inspect(run.id)}
						><strong>{run.contactName || run.triggerType || 'Scheduled run'}</strong><span
							>{run.state} · {run.stepsCompleted} steps · {new Date(
								run.createdAt
							).toLocaleString()}</span
						>{#if run.lastError}<small>{run.lastError}</small>{/if}</button
					>
					<div class="actions">
						{#if run.state === 'failed'}<button
								disabled={busy}
								on:click={() => update(run.id, 'retry')}>Retry</button
							>{/if}{#if ['queued', 'waiting', 'running'].includes(run.state)}<button
								disabled={busy}
								on:click={() => update(run.id, 'cancel')}>Cancel</button
							>{/if}
					</div>
				</article>{/each}{:else}<p class="empty">No runs for this workflow yet.</p>{/if}
	</div>
	{#if selectedRun}<section class="detail">
			<h3>Step history</h3>
			{#if steps.length}<ol>
					{#each steps as step}<li>
							<strong>{step.nodeId}</strong> · {step.state}{#if step.error}<span>
									— {step.error}</span
								>{/if}
						</li>{/each}
				</ol>{:else}<p>No completed steps have been recorded.</p>{/if}
		</section>{/if}
</section>

<style>
	.monitor {
		color: var(--text, #192b29);
		background: var(--surface, #fff);
		border: 1px solid var(--border, #dbe5e1);
		border-radius: 16px;
		padding: 1.25rem;
	}
	header {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 1rem;
	}
	h2 {
		margin: 0.2rem 0;
	}
	.eyebrow {
		font-size: 0.75rem;
		text-transform: uppercase;
		color: #4a7568;
		letter-spacing: 0.08em;
		margin: 0;
	}
	.monitor p {
		color: #657873;
	}
	label {
		display: grid;
		gap: 0.3rem;
		font-weight: 600;
	}
	select {
		font: inherit;
		padding: 0.55rem;
		border: 1px solid #cddbd5;
		border-radius: 8px;
	}
	.runs {
		display: grid;
		gap: 0.6rem;
	}
	.runs article {
		display: flex;
		gap: 1rem;
		align-items: center;
		justify-content: space-between;
		border: 1px solid #e1eae6;
		border-radius: 10px;
		padding: 0.6rem;
	}
	.runs article.selected {
		background: #f4f8f6;
	}
	.run {
		display: grid;
		text-align: left;
		gap: 0.25rem;
		flex: 1;
		border: 0;
		background: transparent;
		color: inherit;
		cursor: pointer;
	}
	.run span,
	.run small,
	.empty {
		color: #657873;
		font-size: 0.88rem;
	}
	.actions {
		display: flex;
		gap: 0.4rem;
	}
	.actions button {
		border: 1px solid #aac0b8;
		border-radius: 7px;
		background: white;
		padding: 0.45rem 0.65rem;
		cursor: pointer;
	}
	.detail {
		border-top: 1px solid #e1eae6;
		margin-top: 1rem;
		padding-top: 0.6rem;
	}
	.detail li {
		margin: 0.4rem 0;
	}
	@media (max-width: 650px) {
		header,
		.runs article {
			flex-direction: column;
			align-items: stretch;
		}
	}
</style>
