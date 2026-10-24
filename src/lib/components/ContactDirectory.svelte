<script lang="ts">
	import { untrack } from 'svelte';
	import Papa from 'papaparse';
	let {
		tenant,
		refreshKey = 0,
		onChanged = () => {},
		onAdd = () => {}
	} = $props<{
		tenant: string;
		refreshKey?: number;
		onChanged?: () => void;
		onAdd?: () => void;
	}>();
	let items = $state<any[]>([]),
		total = $state(0),
		next = $state<string | null>(null),
		history = $state<string[]>([]),
		cursor = $state(''),
		query = $state(''),
		stage = $state(''),
		selected = $state<string[]>([]),
		busy = $state(false),
		error = $state(''),
		notice = $state('');
	let searchTimer: ReturnType<typeof setTimeout>;
	let operation = $state('tag'),
		value = $state(''),
		confirmed = $state(false),
		filters = $state<any[]>([]),
		batches = $state<any[]>([]),
		duplicates = $state<any[]>([]),
		filterName = $state(''),
		csv = $state(''),
		headers = $state<string[]>([]),
		mapping = $state<Record<string, string>>({}),
		preview = $state<any>(null),
		showImport = $state(false);
	let loadRequestId = 0;
	async function request(url: string, body?: unknown) {
		const r = await fetch(url, {
			method: body ? 'POST' : 'GET',
			headers: body ? { 'content-type': 'application/json' } : undefined,
			body: body ? JSON.stringify(body) : undefined
		});
		const data = await r.json();
		if (!r.ok) throw new Error(data.error || 'Request failed.');
		return data;
	}
	async function load(reset = false) {
		const requestId = ++loadRequestId;
		busy = true;
		error = '';
		try {
			if (reset) {
				cursor = '';
				history = [];
			}
			const data = await request(
				`/api/v1/contacts?${new URLSearchParams({ q: query, stage, cursor, limit: '25' })}`
			);
			if (requestId !== loadRequestId) return;
			items = data.items;
			total = data.total;
			next = data.nextCursor;
			selected = [];
		} catch (e) {
			if (requestId === loadRequestId)
				error = e instanceof Error ? e.message : 'People unavailable.';
		} finally {
			if (requestId === loadRequestId) busy = false;
		}
	}
	async function metadata() {
		try {
			const data = await request('/api/v1/crm?directory=true');
			filters = data.filters || [];
			batches = data.importBatches || [];
		} catch (e) {
			error = e instanceof Error ? e.message : 'Saved filters unavailable.';
		}
	}
	async function command(body: unknown) {
		try {
			await request('/api/v1/crm', body);
			notice = 'Saved.';
			confirmed = false;
			await load();
			await metadata();
			onChanged();
		} catch (e) {
			error = e instanceof Error ? e.message : 'Change failed.';
		}
	}
	async function reviewDuplicates() {
		try {
			duplicates = (await request('/api/v1/crm?duplicates=true')).duplicates;
		} catch (e) {
			error = e instanceof Error ? e.message : 'Duplicate review unavailable.';
		}
	}
	function readHeaders() {
		headers = Papa.parse(csv, { header: true, preview: 1 }).meta.fields || [];
		mapping = Object.fromEntries(
			['name', 'email', 'phone', 'stage', 'tags'].map((k) => [
				k,
				headers.find((h) => h.toLowerCase() === k) || ''
			])
		);
		preview = null;
	}
	async function importCsv(dryRun = true) {
		busy = true;
		error = '';
		try {
			const result = await request('/api/v1/contacts/import', { tenant, csv, mapping, dryRun });
			preview = result.preview;
			if (!dryRun) {
				notice = `Imported ${result.imported} people.`;
				csv = '';
				preview = null;
				showImport = false;
				await load(true);
				await metadata();
				onChanged();
			}
		} catch (e) {
			error = e instanceof Error ? e.message : 'Import failed.';
		} finally {
			busy = false;
		}
	}
	$effect(() => {
		if (typeof refreshKey === 'number')
			untrack(() => {
				void load();
				void metadata();
			});
	});
</script>

<section class="directory">
	<header>
		<div>
			<span class="eyebrow">RELATIONSHIPS AT THE HEART OF IT</span>
			<h1>Your people<span class="heading-dot">.</span></h1>
			<p>Every name is a story. Every connection, a possibility.</p>
		</div>
		<div class="actions">
			<button onclick={() => (showImport = !showImport)}>Import</button><button
				class="primary"
				onclick={onAdd}>Add a person</button
			>
		</div>
	</header>
	<nav class="tabs">
		<a href={`/app/${tenant}/contacts`}>All people ({total})</a><a
			href={`/app/${tenant}/households`}>Households</a
		><a href={`/app/${tenant}/organizations`}>Organizations</a><a href={`/app/${tenant}/segments`}
			>Segments</a
		>
	</nav>
	{#if error}<p class="banner error" role="alert">{error}</p>{/if}{#if notice}<p
			class="banner"
			role="status"
		>
			{notice}
		</p>{/if}
	<form
		class="toolbar"
		onsubmit={(e) => {
			e.preventDefault();
			load(true);
		}}
	>
		<label
			>Search people<input
				bind:value={query}
				oninput={() => {
					clearTimeout(searchTimer);
					searchTimer = setTimeout(() => load(true), 250);
				}}
				placeholder="Find a name or email…"
			/></label
		><label
			>Stage<select bind:value={stage}
				><option value="">All stages</option
				>{#each ['new', 'engaged', 'active', 'lapsed', 'major'] as s}<option value={s}>{s}</option
					>{/each}</select
			></label
		><button disabled={busy}>Search</button><label
			>Saved filter<select
				onchange={(e) => {
					const f = filters.find((f) => f.id === e.currentTarget.value);
					if (f) {
						query = f.definition.query || '';
						stage = f.definition.stage || '';
						load(true);
					}
				}}
				><option value="">Choose filter</option>{#each filters as f}<option value={f.id}
						>{f.name}</option
					>{/each}</select
			></label
		>
	</form>
	<details>
		<summary>Save filter and review duplicates</summary>
		<div class="toolbar">
			<label>Filter name<input bind:value={filterName} /></label><button
				disabled={!filterName.trim()}
				onclick={() =>
					command({ action: 'filter', name: filterName, definition: { query, stage } })}
				>Save filter</button
			><button onclick={reviewDuplicates}>Find duplicate candidates</button>
		</div>
		{#each duplicates as group}<article>
				<strong>{group.reason}</strong>
				<p>{group.value}</p>
				{#each group.contacts as c}<a href={`/app/${tenant}/contacts/${c.id}`}
						>{c.name} — review profile and merge</a
					>{/each}
			</article>{/each}
	</details>
	{#if selected.length}<fieldset>
			<legend>{selected.length} selected people</legend><label
				>Action<select bind:value={operation}
					><option value="tag">Add tag</option><option value="stage">Set stage</option><option
						value="archive">Archive</option
					></select
				></label
			>{#if operation !== 'archive'}<label>Value<input bind:value /></label>{/if}<label
				class="inline"
				><input type="checkbox" bind:checked={confirmed} /> I confirm this change for all selected people</label
			><button
				disabled={!confirmed || busy}
				onclick={() =>
					command({ action: 'bulk', contactIds: selected, operation, value, confirmed: true })}
				>Apply to selected people</button
			>
		</fieldset>{/if}
	<div class="table-wrap">
		<table>
			<caption>{total} matching people</caption><thead
				><tr
					><th
						><input
							type="checkbox"
							aria-label="Select current page"
							checked={items.length > 0 && selected.length === items.length}
							onchange={(e) => (selected = e.currentTarget.checked ? items.map((x) => x.id) : [])}
						/></th
					><th>Name</th><th>Email</th><th>Stage</th></tr
				></thead
			><tbody
				>{#each items as c}<tr
						><td
							><input
								type="checkbox"
								aria-label={`Select ${c.name}`}
								checked={selected.includes(c.id)}
								onchange={(e) =>
									(selected = e.currentTarget.checked
										? [...selected, c.id]
										: selected.filter((x) => x !== c.id))}
							/></td
						><td><a href={`/app/${tenant}/contacts/${c.id}`}>{c.name}</a></td><td
							>{c.email || '—'}</td
						><td>{c.stage || 'new'}</td></tr
					>{:else}<tr><td colspan="4">{busy ? 'Loading…' : 'No matching people.'}</td></tr
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
				load();
			}}>Previous</button
		><span>Page {history.length + 1}</span><button
			disabled={!next || busy}
			onclick={() => {
				history = [...history, cursor];
				cursor = next || '';
				load();
			}}>Next</button
		><a href={`/api/v1/contacts/export?tenant=${tenant}`}>Export people CSV</a>
	</div>
	{#if showImport}<section class="panel">
			<h2>Review a contact import</h2>
			<label
				>CSV file<input
					type="file"
					accept=".csv,text/csv"
					onchange={async (e) => {
						const file = e.currentTarget.files?.[0];
						if (file) {
							csv = await file.text();
							readHeaders();
						}
					}}
				/></label
			><label
				>CSV content<textarea rows="7" bind:value={csv} oninput={readHeaders}></textarea></label
			>
			<div class="toolbar">
				{#each ['name', 'email', 'phone', 'stage', 'tags'] as field}<label
						>{field} column<select bind:value={mapping[field]} onchange={() => (preview = null)}
							><option value="">Not mapped</option>{#each headers as h}<option value={h}>{h}</option
								>{/each}</select
						></label
					>{/each}
			</div>
			<button disabled={!csv || !mapping.name || busy} onclick={() => importCsv(true)}
				>Dry-run import</button
			>{#if preview}<p>
					{preview.createCount} ready · {preview.duplicateCount} duplicate · {preview.invalidCount} invalid
				</p>
				<ul>
					{#each preview.rows.filter((r: any) => r.status !== 'ready') as row}<li>
							Row {row.row}: {row.reason}
						</li>{/each}
				</ul>
				<button
					class="primary"
					disabled={busy ||
						preview.duplicateCount > 0 ||
						preview.invalidCount > 0 ||
						!preview.createCount}
					onclick={() => importCsv(false)}>Confirm reviewed import</button
				>{/if}
		</section>{/if}
	{#if batches.length}<details>
			<summary>Import history and rollback</summary>{#each batches as batch}<article>
					<strong
						>{batch.importedCount} contacts · {new Date(batch.createdAt).toLocaleString()}</strong
					>{#if batch.rolledBackAt}<p>Rolled back</p>{:else}<button
							onclick={() => {
								if (
									window.confirm(
										'Archive this import batch? Rollback is refused if records changed or have gifts.'
									)
								)
									command({ action: 'rollback_import', batchId: batch.id, confirmed: true });
							}}>Review and roll back batch</button
						>{/if}
				</article>{/each}
		</details>{/if}
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
	.inline {
		display: flex;
		align-items: center;
	}
	input,
	select,
	textarea,
	button {
		font: inherit;
	}
	input,
	select,
	textarea {
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
	}
	caption {
		text-align: left;
		color: var(--muted);
		padding: 0.5rem;
	}
	a {
		color: var(--text);
	}
	fieldset,
	.panel,
	details {
		border: 1px solid var(--border);
		border-radius: 12px;
		padding: 1rem;
	}
	fieldset {
		display: grid;
		gap: 0.6rem;
	}
	article {
		padding: 0.8rem 0;
		display: grid;
		gap: 0.4rem;
	}
	.tabs {
		display: flex;
		gap: 1rem;
		flex-wrap: wrap;
	}
	.primary {
		background: var(--accent);
		color: white;
	}
</style>
