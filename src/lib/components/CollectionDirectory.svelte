<script lang="ts">
	import { onMount } from 'svelte';
	type Resource = 'organizations' | 'households' | 'segments';
	let {
		tenant,
		resource,
		contacts = [],
		onCreate = () => {},
		onEdit = (_item: any) => {}
	} = $props<{
		tenant: string;
		resource: Resource;
		contacts?: Array<Record<string, any>>;
		onCreate?: () => void;
		onEdit?: (item: Record<string, any>) => void;
	}>();
	let items = $state<Record<string, any>[]>([]),
		total = $state(0),
		cursor = $state(''),
		next = $state<string | null>(null),
		history = $state<string[]>([]);
	let query = $state(''),
		sort = $state<'name_asc' | 'name_desc'>('name_asc'),
		selected = $state<string[]>([]),
		canWrite = $state(false),
		busy = $state(false),
		error = $state(''),
		notice = $state('');
	let searchTimer: ReturnType<typeof setTimeout>;
	const title = $derived(
		resource === 'organizations'
			? 'Organizations'
			: resource === 'households'
				? 'Households'
				: 'Segments'
	);
	function formatMinor(amount: number, currency: string) {
		try {
			return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(amount / 100);
		} catch {
			return `${currency} ${(amount / 100).toFixed(2)}`;
		}
	}
	async function load(reset = false) {
		busy = true;
		error = '';
		if (reset) {
			cursor = '';
			history = [];
		}
		try {
			const params = new URLSearchParams({ tenant, q: query, sort, limit: '25', cursor });
			const response = await fetch(`/api/v1/collections/${resource}?${params}`);
			const data = await response.json();
			if (!response.ok) throw new Error(data.error || 'Collection unavailable.');
			items = data.items;
			total = data.total;
			next = data.nextCursor;
			canWrite = data.canWrite;
			selected = [];
		} catch (e) {
			error = e instanceof Error ? e.message : 'Collection unavailable.';
		} finally {
			busy = false;
		}
	}
	async function archiveSelected() {
		if (
			!canWrite ||
			!selected.length ||
			!window.confirm(
				`Archive ${selected.length} selected ${title.toLowerCase()}? This removes them from active directories.`
			)
		)
			return;
		busy = true;
		error = '';
		try {
			for (const id of selected) {
				const item = items.find((row) => row.id === id);
				if (!item) continue;
				const data = { ...item };
				delete data.memberNames;
				delete data.matchingContactCount;
				const response = await fetch('/api/v1/workspace?compact=true', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ tenant, resource, action: 'archive', data })
				});
				const result = await response.json();
				if (!response.ok) throw new Error(result.error || `Could not archive ${item.name}.`);
			}
			notice = `Archived ${selected.length} ${title.toLowerCase()}.`;
			await load(true);
		} catch (e) {
			error = e instanceof Error ? e.message : 'Archive failed.';
			await load(true);
		} finally {
			busy = false;
		}
	}
	onMount(() => {
		void load(true);
	});
</script>

<section class="directory">
	<header>
		<div>
			<span class="eyebrow">YOUR COMMUNITY</span>
			<h1>{title}<span class="heading-dot">.</span></h1>
			<p>Search and manage {title.toLowerCase()} across the full workspace.</p>
		</div>
		<div class="actions">
			<button class="primary" disabled={!canWrite} onclick={onCreate}
				>Add {resource === 'organizations'
					? 'organization'
					: resource === 'households'
						? 'household'
						: 'segment'}</button
			>
		</div>
	</header>
	{#if error}<p class="banner error" role="alert">{error}</p>{/if}{#if notice}<p
			class="banner"
			role="status"
		>
			{notice}
		</p>{/if}
	<form
		class="toolbar"
		onsubmit={(event) => {
			event.preventDefault();
			void load(true);
		}}
	>
		<label
			>Search {title.toLowerCase()}<input
				bind:value={query}
				oninput={() => {
					clearTimeout(searchTimer);
					searchTimer = setTimeout(() => load(true), 250);
				}}
				placeholder="Search by name…"
			/></label
		><label
			>Sort<select bind:value={sort} onchange={() => load(true)}
				><option value="name_asc">Name A to Z</option><option value="name_desc">Name Z to A</option
				></select
			></label
		><button disabled={busy}>Search</button>
	</form>
	{#if selected.length && canWrite}<fieldset>
			<legend>{selected.length} selected</legend>
			<p>Archiving keeps the records in history and removes them from active lists.</p>
			<button class="danger" disabled={busy} onclick={archiveSelected}>Archive selected</button>
		</fieldset>{/if}
	<div class="table-wrap">
		<table>
			<caption>{total} active {title.toLowerCase()}</caption><thead
				><tr
					><th
						><input
							type="checkbox"
							aria-label="Select current page"
							checked={items.length > 0 && selected.length === items.length}
							onchange={(event) =>
								(selected = event.currentTarget.checked ? items.map((item) => item.id) : [])}
						/></th
					><th>Name</th>{#if resource === 'organizations'}<th>Type</th><th>Website</th
						>{:else if resource === 'households'}<th>Members</th><th>Giving (hard credit)</th
						>{:else}<th>Matching people</th><th>Rules</th>{/if}<th>Actions</th></tr
				></thead
			><tbody>
				{#each items as item (item.id)}<tr
						><td
							><input
								type="checkbox"
								aria-label={`Select ${item.name}`}
								checked={selected.includes(item.id)}
								onchange={(event) =>
									(selected = event.currentTarget.checked
										? [...selected, item.id]
										: selected.filter((id) => id !== item.id))}
							/></td
						><td>{item.name}</td>
						{#if resource === 'organizations'}<td>{item.type || '—'}</td><td
								>{#if item.website}<a href={item.website} target="_blank" rel="noopener noreferrer"
										>Website<span class="sr-only"> (opens in a new tab)</span></a
									>{:else}—{/if}</td
							>
						{:else if resource === 'households'}<td
								>{#if item.memberNames?.length}<ul>
										{#each item.memberNames as name}<li>{name}</li>{/each}
									</ul>{:else}No active members{/if}</td
							>
							<td
								><div class="giving-totals">
									{#if item.hardCreditGivingByCurrency?.length}{#each item.hardCreditGivingByCurrency as total}<span
												>{formatMinor(total.netRecordedMinor, total.currency)} net / {formatMinor(
													total.grossMinor,
													total.currency
												)} gross · {total.giftCount} gifts</span
											>{/each}{:else}<span>No hard-credit gifts</span>{/if}<small
										>Soft credits excluded.</small
									>
								</div></td
							>
						{:else}<td>{item.matchingContactCount ?? 0}</td><td>{item.rules?.length ?? 0}</td>{/if}
						<td><button onclick={() => onEdit(item)}>Edit</button></td></tr
					>
				{:else}<tr><td colspan="6">{busy ? 'Loading…' : 'No matching records.'}</td></tr
					>{/each}</tbody
			>
		</table>
	</div>
	<div class="actions">
		<button
			disabled={!history.length || busy}
			onclick={() => {
				cursor = history.at(-1) || '';
				history = history.slice(0, -1);
				void load();
			}}>Previous</button
		><span>Page {history.length + 1}</span><button
			disabled={!next || busy}
			onclick={() => {
				history = [...history, cursor];
				cursor = next || '';
				void load();
			}}>Next</button
		>
	</div>
</section>

<style>
	.directory {
		display: grid;
		gap: 1.2rem;
	}
	header,
	.toolbar,
	.actions {
		display: flex;
		align-items: center;
		gap: 0.8rem;
		flex-wrap: wrap;
	}
	header {
		justify-content: space-between;
	}
	header h1 {
		margin: 0.4rem 0;
	}
	.toolbar label,
	label {
		display: grid;
		gap: 0.35rem;
	}
	input,
	select,
	button {
		font: inherit;
	}
	input,
	select {
		padding: 0.65rem;
		border: 1px solid var(--border);
		border-radius: 8px;
		background: var(--surface);
		color: var(--text);
	}
	button {
		padding: 0.65rem 0.9rem;
		border: 1px solid var(--border);
		border-radius: 8px;
		background: var(--surface);
		color: var(--text);
		cursor: pointer;
	}
	button:disabled {
		opacity: 0.5;
	}
	.table-wrap {
		overflow: auto;
	}
	table {
		width: 100%;
		border-collapse: collapse;
		text-align: left;
	}
	td,
	th {
		padding: 0.9rem;
		border-bottom: 1px solid var(--border);
		vertical-align: top;
	}
	caption {
		text-align: left;
		color: var(--muted);
		padding: 0.5rem;
	}
	a {
		color: var(--text);
	}
	fieldset {
		border: 1px solid var(--border);
		border-radius: 12px;
		padding: 1rem;
		display: flex;
		align-items: center;
		gap: 1rem;
		flex-wrap: wrap;
	}
	.primary {
		background: var(--accent);
		color: white;
	}
	.danger {
		border-color: #a22;
		color: #a22;
	}
	ul {
		margin: 0;
		padding-left: 1.2rem;
	}
	.giving-totals {
		display: grid;
		gap: 0.35rem;
		min-width: 15rem;
	}
	.giving-totals small {
		color: var(--muted);
	}
	.sr-only {
		position: absolute;
		width: 1px;
		height: 1px;
		padding: 0;
		margin: -1px;
		overflow: hidden;
		clip: rect(0, 0, 0, 0);
		white-space: nowrap;
		border: 0;
	}
</style>
