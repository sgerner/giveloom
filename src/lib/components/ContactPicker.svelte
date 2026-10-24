<script lang="ts">
	import { onDestroy } from 'svelte';
	let {
		tenant,
		contactId = $bindable(''),
		onSelect = () => {},
		label = 'Supporter',
		placeholder = 'Search by name or email…',
		required = false
	} = $props<{
		tenant: string;
		contactId?: string;
		onSelect?: (contact: any | null) => void;
		label?: string;
		placeholder?: string;
		required?: boolean;
	}>();
	const pickerId = $props.id();
	let inputElement = $state<HTMLInputElement>();
	let query = $state(''),
		items = $state<any[]>([]),
		selectedName = $state(''),
		nextCursor = $state<string | null>(null),
		busy = $state(false),
		error = $state('');
	let timer: ReturnType<typeof setTimeout> | undefined;
	let requestId = 0,
		resolvedContactId = '';
	async function search(reset = true) {
		if (reset) {
			items = [];
			nextCursor = null;
		}
		const id = ++requestId;
		busy = true;
		error = '';
		try {
			const params = new URLSearchParams({ q: query.trim(), limit: '15' });
			if (!reset && nextCursor) params.set('cursor', nextCursor);
			const response = await fetch(`/api/v1/contacts?${params}`);
			const data = await response.json();
			if (!response.ok) throw new Error(data.error || 'Supporter search failed.');
			if (id !== requestId) return;
			items = reset ? data.items || [] : [...items, ...(data.items || [])];
			nextCursor = data.nextCursor || null;
		} catch (e) {
			if (id === requestId) error = e instanceof Error ? e.message : 'Supporter search failed.';
		} finally {
			if (id === requestId) busy = false;
		}
	}
	function typeSearch() {
		++requestId;
		busy = false;
		items = [];
		nextCursor = null;
		contactId = '';
		resolvedContactId = '';
		selectedName = '';
		onSelect(null);
		clearTimeout(timer);
		timer = setTimeout(() => void search(true), 220);
	}
	function choose(contact: any) {
		clearTimeout(timer);
		++requestId;
		busy = false;
		error = '';
		contactId = contact?.id || '';
		resolvedContactId = contactId;
		selectedName = contact?.name || '';
		query = '';
		items = [];
		nextCursor = null;
		onSelect(contact || null);
	}
	export function clearSelection() {
		choose(null);
	}
	$effect(() => {
		inputElement?.setCustomValidity(
			query.trim() && !contactId ? 'Select a supporter from the results, or clear the search.' : ''
		);
	});
	$effect(() => {
		const id = contactId;
		if (id !== resolvedContactId) {
			resolvedContactId = id;
			selectedName = '';
		}
		if (!id || items.some((item) => item.id === id) || selectedName) return;
		let active = true;
		void fetch(`/api/v1/contacts/${encodeURIComponent(id)}`)
			.then(async (r) => {
				const data = await r.json();
				if (r.ok && active) selectedName = data.contact?.name || '';
			})
			.catch(() => {});
		return () => {
			active = false;
		};
	});
	onDestroy(() => {
		clearTimeout(timer);
		++requestId;
	});
</script>

<div class="contact-picker">
	<label
		>{label}<input
			bind:this={inputElement}
			role="combobox"
			aria-autocomplete="list"
			aria-expanded={items.length > 0}
			aria-controls={pickerId + '-options'}
			bind:value={query}
			oninput={typeSearch}
			placeholder={contactId ? selectedName || 'Selected supporter' : placeholder}
			required={required && !contactId}
		/></label
	>
	{#if contactId}<button
			class="clear"
			type="button"
			aria-label="Clear selected supporter"
			onclick={() => choose(null)}>Clear</button
		>{/if}
	{#if error}<p class="error" role="alert">{error}</p>{/if}
	{#if busy}<p class="hint" role="status">Searching…</p>{/if}
	{#if items.length}<ul id={pickerId + '-options'} role="listbox">
			{#each items as item (item.id)}<li>
					<button
						type="button"
						role="option"
						aria-selected={item.id === contactId}
						onclick={() => choose(item)}
						><strong>{item.name}</strong><small
							>{item.email || 'No email'} · {item.stage || 'new'}</small
						></button
					>
				</li>{/each}
		</ul>{/if}
	{#if nextCursor && items.length}<button
			class="more"
			type="button"
			disabled={busy}
			onclick={() => search(false)}>Load more supporters</button
		>{/if}
</div>

<style>
	.contact-picker {
		position: relative;
		display: grid;
		gap: 5px;
		min-width: 0;
	}
	.contact-picker label {
		display: grid;
		gap: 5px;
		font-size: 11px;
	}
	.contact-picker input {
		min-width: 0;
		width: 100%;
		box-sizing: border-box;
		padding: 9px;
		border: 1px solid var(--border, #d5ded7);
		border-radius: 7px;
		background: var(--surface, #fff);
		color: var(--text, #17251f);
		font: inherit;
	}
	.contact-picker ul {
		position: absolute;
		z-index: 20;
		top: 100%;
		left: 0;
		right: 0;
		max-height: 260px;
		overflow: auto;
		margin: 0;
		padding: 4px;
		list-style: none;
		border: 1px solid var(--border, #cbd6cd);
		border-radius: 8px;
		background: var(--surface, #fff);
		box-shadow: 0 8px 24px #17251f20;
	}
	.contact-picker li button {
		width: 100%;
		display: grid;
		gap: 3px;
		text-align: left;
		padding: 8px;
		border: 0;
		border-radius: 5px;
		background: transparent;
		color: inherit;
		cursor: pointer;
	}
	.contact-picker li button:hover,
	.contact-picker li button:focus-visible {
		background: var(--surface-muted, #f2f5f1);
	}
	.contact-picker strong {
		font-size: 11px;
	}
	.contact-picker small,
	.hint {
		font-size: 10px;
		color: var(--muted, #66736c);
	}
	.clear,
	.more {
		justify-self: start;
		border: 0;
		background: transparent;
		color: var(--accent, #315d48);
		text-decoration: underline;
		font: inherit;
		font-size: 10px;
		cursor: pointer;
	}
	.error {
		margin: 0;
		color: #9d3d36;
		font-size: 10px;
	}
</style>
