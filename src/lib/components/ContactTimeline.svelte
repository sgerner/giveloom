<script lang="ts">
	import { onMount } from 'svelte';
	import { formatMoney } from '$lib/money';
	let { contactId, kind = 'all' } = $props<{ contactId: string; kind?: string }>();
	let items = $state<any[]>([]),
		selected = $state('all'),
		cursor = $state<string | null>(null),
		busy = $state(false),
		error = $state('');
	async function load(more = false) {
		busy = true;
		error = '';
		try {
			const params = new URLSearchParams({
				timeline: contactId,
				kind: selected,
				...(more && cursor ? { cursor } : {})
			});
			const r = await fetch('/api/v1/crm?' + params);
			const data = await r.json();
			if (!r.ok) throw new Error(data.error || 'Timeline unavailable.');
			items = more ? [...items, ...data.items] : data.items;
			cursor = data.nextCursor;
		} catch (e) {
			error = e instanceof Error ? e.message : 'Timeline unavailable.';
		} finally {
			busy = false;
		}
	}
	onMount(() => {
		selected = kind;
		load();
	});
</script>

<section class="contact-timeline" aria-label="Contact timeline">
	<div class="toolbar">
		<label
			>Activity type<select bind:value={selected} onchange={() => load()}
				>{#each ['all', 'gift', 'activity', 'task', 'note', 'email', 'automation', 'consent'] as type}<option
						value={type}>{type === 'all' ? 'All recorded activity' : type}</option
					>{/each}</select
			></label
		><button onclick={() => load()} disabled={busy}>Refresh timeline</button>
	</div>
	{#if error}<p class="banner error" role="alert">{error}</p>{/if}
	<ol>
		{#each items as item}<li>
				<div>
					<span class="eyebrow">{item.kind} · {new Date(item.at).toLocaleString()}</span>
					<h3>{item.summary}</h3>
					{#if item.details?.amountMinor !== undefined}<p>
							{formatMoney(Number(item.details.amountMinor), String(item.details.currency).trim())}
						</p>{/if}{#if item.details?.status}<p>
							Status: {item.details.status.replaceAll('_', ' ')}
						</p>{/if}{#if item.details?.source}<p>
							Source: {item.details.source}
						</p>{/if}{#if item.details?.dueAt}<p>
							Due: {new Date(item.details.dueAt).toLocaleString()}
						</p>{/if}{#if item.details?.correctionOf}<p>
							Corrects immutable event {item.details.correctionOf}
						</p>{/if}
				</div>
			</li>{:else}<li>
				{busy ? 'Gathering recorded moments…' : 'No activity matches this filter.'}
			</li>{/each}
	</ol>
	{#if cursor}<button disabled={busy} onclick={() => load(true)}
			>{busy ? 'Loading…' : 'Load earlier activity'}</button
		>{/if}
</section>

<style>
	.contact-timeline {
		padding: 1rem 0;
		color: var(--ink);
	}
	.contact-timeline .eyebrow {
		color: var(--muted);
	}
	.contact-timeline label,
	.contact-timeline button,
	.contact-timeline h3 {
		color: var(--ink);
	}
	.toolbar {
		display: flex;
		align-items: end;
		gap: 1rem;
		flex-wrap: wrap;
	}
	label {
		display: grid;
		gap: 0.4rem;
	}
	select,
	button {
		font: inherit;
		color: var(--ink);
		padding: 0.6rem;
		border: 1px solid var(--line);
		background: var(--white);
	}
	ol {
		list-style: none;
		padding: 0;
	}
	li {
		border-bottom: 1px solid var(--line);
		padding: 1.2rem 0;
	}
	h3 {
		font-size: 1rem;
		font-weight: 500;
		margin: 0.5rem 0;
		color: var(--ink);
	}
	p {
		font-size: 0.85rem;
		color: var(--muted);
	}
</style>
