<script lang="ts">
	import { onMount } from 'svelte';
	import { Bell, X } from 'lucide-svelte';
	let { tenant } = $props<{ tenant: string }>();
	let open = $state(false),
		items = $state<any[]>([]),
		error = $state(''),
		busy = $state(false);
	let unread = $derived(items.filter((i) => !i.readAt).length);
	async function load() {
		try {
			const r = await fetch('/api/v1/notifications');
			const body = await r.json();
			if (!r.ok) throw new Error(body.error || 'Inbox unavailable.');
			items = body.notifications || [];
		} catch (e) {
			error = e instanceof Error ? e.message : 'Inbox unavailable.';
		}
	}
	async function mark(id: string) {
		busy = true;
		try {
			const r = await fetch('/api/v1/notifications/' + id, { method: 'PATCH' });
			if (!r.ok) throw new Error('Notification could not be marked read.');
			await load();
		} catch (e) {
			error = e instanceof Error ? e.message : 'Notification update failed.';
		} finally {
			busy = false;
		}
	}
	onMount(() => {
		load();
		const timer = setInterval(load, 60000);
		return () => clearInterval(timer);
	});
</script>

<div class="inbox-anchor">
	<button
		class="icon-button"
		aria-label={`Notifications${unread ? `: ${unread} unread` : ''}`}
		aria-expanded={open}
		onclick={() => {
			open = !open;
			if (open) load();
		}}
		><Bell size={20} />{#if unread}<span class="count">{unread}</span>{/if}</button
	>{#if open}<aside class="inbox" aria-label="Notification inbox">
			<header>
				<h2>Your quiet corner</h2>
				<button class="icon-button" aria-label="Close notifications" onclick={() => (open = false)}
					><X size={18} /></button
				>
			</header>
			{#if error}<p role="alert">{error}</p>{/if}
			<ul>
				{#each items as item}<li>
						<strong>{item.title}</strong>
						<p>{item.body}</p>
						<small>{new Date(item.createdAt).toLocaleString()}</small>{#if !item.readAt}<button
								disabled={busy}
								onclick={() => mark(item.id)}>Mark read</button
							>{:else}<small>Read</small>{/if}
					</li>{:else}<li>No internal reminders yet.</li>{/each}
			</ul>
			<a href={`/app/${tenant}/tasks`} onclick={() => (open = false)}
				>Open tasks and stewardship →</a
			>
		</aside>{/if}
</div>

<style>
	.inbox-anchor {
		position: relative;
	}
	.count {
		font-size: 0.65rem;
		background: var(--accent);
		color: var(--paper);
		border-radius: 50%;
		padding: 2px 5px;
	}
	.inbox {
		position: absolute;
		right: 0;
		top: 3rem;
		width: min(370px, 85vw);
		max-height: 75vh;
		overflow: auto;
		z-index: 80;
		background: var(--white);
		border: 1px solid var(--line);
		padding: 1.2rem;
		color: var(--ink);
	}
	header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
	}
	h2 {
		font:
			22px Georgia,
			serif;
		margin: 0;
	}
	ul {
		list-style: none;
		padding: 0;
	}
	li {
		padding: 1rem 0;
		border-bottom: 1px solid var(--line);
		display: grid;
		gap: 0.35rem;
	}
	p {
		margin: 0;
		font-size: 0.85rem;
	}
	small {
		color: var(--muted);
	}
	li button {
		text-align: left;
		text-decoration: underline;
		font-size: 0.8rem;
	}
	a {
		display: block;
		margin-top: 1rem;
		font-size: 0.85rem;
	}
</style>
