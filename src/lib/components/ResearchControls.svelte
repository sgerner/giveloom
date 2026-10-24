<script lang="ts">
	import { onMount } from 'svelte';
	let { tenant, onChanged = () => {} } = $props<{ tenant: string; onChanged?: () => void }>();
	let model = $state<any>({
			sources: [],
			queue: [],
			members: [],
			funnel: [],
			transitions: [],
			weights: { affinity: 35, philanthropy: 25, connection: 20, recency: 10, geography: 10 }
		}),
		error = $state(''),
		notice = $state(''),
		busy = $state(false),
		source = $state<any>({
			name: '',
			sourceType: 'licensed_provider',
			licenseLabel: '',
			sourceUrl: '',
			permittedUses: ['research', 'internal_review'],
			exportAllowed: false,
			outreachAllowed: false,
			enabled: true,
			notes: ''
		}),
		queue = $state<any>({
			title: '',
			criteria: {},
			sourceIds: [],
			budgetCapMinor: 0,
			currency: 'USD',
			assignedTo: ''
		}),
		mission = $state(''),
		geography = $state(''),
		comparableCharities = $state(''),
		knownTrustees = $state(''),
		prospectTypes = $state('');
	let queueDue = $state(''),
		researchSourceId = $state(''),
		researchXml = $state(''),
		researchArchive = $state(''),
		researchFileName = $state(''),
		researchPreview = $state<any>(null),
		selectedImports = $state<string[]>([]),
		importBusy = $state(false);
	async function load() {
		try {
			const r = await fetch('/api/v1/research/workbench?tenant=' + encodeURIComponent(tenant));
			const v = await r.json();
			if (!r.ok) throw new Error(v.error);
			model = v;
		} catch (e) {
			error = e instanceof Error ? e.message : 'Research controls unavailable.';
		}
	}
	onMount(load);
	async function post(action: string, payload: any) {
		busy = true;
		error = '';
		notice = '';
		try {
			const r = await fetch('/api/v1/research/workbench', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ tenant, action, ...payload })
			});
			const v = await r.json();
			if (!r.ok) throw new Error(v.error || 'Could not save.');
			notice = v.message || 'Research settings saved.';
			await load();
			onChanged();
			return true;
		} catch (e) {
			error = e instanceof Error ? e.message : 'Could not save.';
			return false;
		} finally {
			busy = false;
		}
	}
	async function addSource(e: SubmitEvent) {
		e.preventDefault();
		if (await post('source', { source })) {
			source = {
				name: '',
				sourceType: 'licensed_provider',
				licenseLabel: '',
				sourceUrl: '',
				permittedUses: ['research', 'internal_review'],
				exportAllowed: false,
				outreachAllowed: false,
				enabled: true,
				notes: ''
			};
		}
	}
	async function addQueue(e: SubmitEvent) {
		e.preventDefault();
		if (
			await post('queue', {
				queue: {
					...queue,
					assignedTo: queue.assignedTo || undefined,
					dueAt: queueDue ? new Date(queueDue).toISOString() : undefined,
					criteria: {
						missionKeywords: mission,
						geography,
						comparableCharities,
						knownTrustees,
						prospectTypes
					}
				}
			})
		) {
			queue = {
				title: '',
				criteria: {},
				sourceIds: [],
				budgetCapMinor: 0,
				currency: 'USD',
				assignedTo: ''
			};
			queueDue = '';
			mission = '';
			geography = '';
			comparableCharities = '';
			knownTrustees = '';
			prospectTypes = '';
		}
	}
	async function toggleSource(item: any) {
		await post('source_update', { sourceUpdate: { id: item.id, enabled: !item.enabled } });
	}
	async function advanceQueue(task: any) {
		const status =
			task.status === 'queued'
				? 'in_progress'
				: task.status === 'in_progress'
					? 'ready_for_review'
					: task.status === 'ready_for_review'
						? 'completed'
						: null;
		if (status)
			await post('queue_status', {
				queueStatus: { id: task.id, status, outcome: task.outcomeText || '' }
			});
	}
	async function readImportFile(event: Event) {
		const file = (event.currentTarget as HTMLInputElement).files?.[0];
		if (!file) return;
		researchFileName = file.name;
		researchXml = '';
		researchArchive = '';
		if (file.size > 5 * 1024 * 1024) {
			error = 'File must be smaller than 5 MiB.';
			return;
		}
		const buffer = await file.arrayBuffer();
		if (file.name.toLowerCase().endsWith('.zip')) {
			const bytes = new Uint8Array(buffer);
			let binary = '';
			for (let i = 0; i < bytes.length; i += 0x8000)
				binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
			researchArchive = btoa(binary);
		} else researchXml = new TextDecoder().decode(buffer);
	}
	async function importFilings(apply = false) {
		importBusy = true;
		error = '';
		notice = '';
		try {
			const body: any = {
				tenant,
				sourceUrl: model.sources.find((s: any) => s.id === researchSourceId)?.sourceUrl,
				sourceId: researchSourceId || undefined,
				apply,
				selectedFingerprints: selectedImports
			};
			if (researchArchive) body.archiveBase64 = researchArchive;
			else body.xml = researchXml;
			const r = await fetch('/api/v1/research/jobs', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body)
			});
			const v = await r.json();
			if (!r.ok) throw new Error(v.error);
			researchPreview = v;
			selectedImports = (v.records || [])
				.filter((x: any) => !x.duplicate)
				.map((x: any) => x.sourceFingerprint);
			notice = apply
				? `${v.imported} reviewed prospect records imported.`
				: `${v.ready} candidates ready for review.`;
			await load();
			onChanged();
		} catch (e) {
			error = e instanceof Error ? e.message : 'Filing import failed.';
		} finally {
			importBusy = false;
		}
	}
	function toggleImport(record: any) {
		selectedImports = selectedImports.includes(record.sourceFingerprint)
			? selectedImports.filter((x) => x !== record.sourceFingerprint)
			: [...selectedImports, record.sourceFingerprint];
	}
	function toggleUse(use: string) {
		source.permittedUses = source.permittedUses.includes(use)
			? source.permittedUses.filter((x: string) => x !== use)
			: [...source.permittedUses, use];
	}
</script>

<section class="controls" aria-labelledby="research-controls-title">
	<div class="head">
		<div>
			<p class="eyebrow">RESEARCH GOVERNANCE</p>
			<h2 id="research-controls-title">Sources, priorities, and review queue</h2>
			<p>
				Licensed sources keep their stated limits. Queued work is manual and never calls a provider.
			</p>
		</div>
	</div>
	{#if error}<p role="alert" class="error">{error}</p>{/if}{#if notice}<p
			role="status"
			class="notice"
		>
			{notice}
		</p>{/if}
	<div class="columns">
		<section>
			<h3>Explainable score weights</h3>
			<p>Weights must total 100. Missing evidence reduces confidence.</p>
			<form
				class="weights"
				onsubmit={(e) => {
					e.preventDefault();
					void post('weights', { weights: model.weights });
				}}
			>
				{#each ['affinity', 'philanthropy', 'connection', 'recency', 'geography'] as key}<label
						>{key}<input type="number" min="0" max="100" bind:value={model.weights[key]} /></label
					>{/each}<span
					>Total {Object.values(model.weights).reduce(
						(a: number, b: any) => a + Number(b),
						0
					)}%</span
				><button disabled={busy}>Save weights</button>
			</form>
			<h3>Source register</h3>
			{#each model.sources as item}<article class="source">
					<strong>{item.name}</strong><small
						>{item.licenseLabel} · {item.enabled ? 'enabled' : 'disabled'}</small
					><small
						>Permitted: {(item.permittedUses || []).join(', ') || 'none'} · Export {item.exportAllowed
							? 'allowed'
							: 'blocked'} · Outreach {item.outreachAllowed ? 'allowed' : 'blocked'}</small
					>{#if item.sourceUrl}<a href={item.sourceUrl} target="_blank" rel="noreferrer"
							>Open source ↗</a
						>{/if}<button
						type="button"
						class="task-action"
						disabled={busy}
						onclick={() => toggleSource(item)}
						>{item.enabled ? 'Disable source' : 'Re-enable source'}</button
					>
				</article>{:else}<p class="muted">
					No source licenses are registered. Add only sources your organization is authorized to
					use.
				</p>{/each}
			<form class="source-form" onsubmit={addSource}>
				<h4>Register a source</h4>
				<label>Source name<input required minlength="2" bind:value={source.name} /></label>
				<div class="pair">
					<label
						>Type<select bind:value={source.sourceType}
							><option value="public_filing">Public filing</option><option value="licensed_provider"
								>Licensed provider</option
							><option value="manual">Manual research</option><option value="other">Other</option
							></select
						></label
					><label
						>License / rights basis<input
							required
							bind:value={source.licenseLabel}
							placeholder="IRS public filing; internal review only"
						/></label
					>
				</div>
				<label
					>Source URL<input
						type="url"
						bind:value={source.sourceUrl}
						placeholder="https://…"
					/></label
				>
				<fieldset>
					<legend>Permitted uses</legend
					>{#each ['research', 'scoring', 'internal_review', 'export', 'outreach'] as use}<label
							class="check"
							><input
								type="checkbox"
								checked={source.permittedUses.includes(use)}
								onchange={() => toggleUse(use)}
							/>{use.replaceAll('_', ' ')}</label
						>{/each}
				</fieldset>
				<label
					>Notes about permitted use<textarea rows="2" bind:value={source.notes}></textarea></label
				><button disabled={busy}>Save source rights</button>
			</form>
			<h3>Filing intake</h3>
			<p>
				Only registered public-filing sources with research permission can be imported. Uploaded
				ZIPs are inspected locally; no remote URL is fetched.
			</p>
			<form
				class="import-form"
				onsubmit={(e) => {
					e.preventDefault();
					void importFilings(false);
				}}
			>
				<label
					>Registered IRS source<select required bind:value={researchSourceId}
						><option value="">Choose source</option
						>{#each model.sources.filter((s: any) => s.sourceType === 'public_filing' && s.enabled && s.permittedUses.includes('research')) as source}<option
								value={source.id}>{source.name} · {source.licenseLabel}</option
							>{/each}</select
					></label
				><label
					>One 990-PF XML or bounded ZIP<input
						type="file"
						accept=".xml,.zip,text/xml,application/zip"
						onchange={readImportFile}
					/></label
				><small>{researchFileName || 'No file selected'} · maximum 5 MiB</small><label
					>Or paste a single XML return<textarea
						rows="5"
						bind:value={researchXml}
						placeholder="Paste a downloaded 990-PF XML filing"></textarea></label
				><button disabled={importBusy || !researchSourceId || (!researchXml && !researchArchive)}
					>Preview filings</button
				>
			</form>
			{#if researchPreview}<div class="import-preview">
					<h4>
						Candidate review · {researchPreview.ready} new · {researchPreview.duplicates} duplicate
					</h4>
					{#each researchPreview.records as record}<label class="review-row"
							><input
								type="checkbox"
								checked={selectedImports.includes(record.sourceFingerprint)}
								onchange={() => toggleImport(record)}
							/><span
								><strong>{record.name}</strong><small>{record.reason}</small><small
									>{record.evidence?.[0]?.sourceName} · {record.filingYear} · {record.filingStatus}</small
								></span
							></label
						>{/each}<button
						disabled={importBusy || !selectedImports.length}
						onclick={() => importFilings(true)}>Import selected reviewed records</button
					>
				</div>{/if}
		</section>
		<section>
			<h3>Research queue</h3>
			<p>Define the task and cap any paid research budget before assigning it.</p>
			<form class="queue-form" onsubmit={addQueue}>
				<label
					>Task title<input
						required
						minlength="2"
						bind:value={queue.title}
						placeholder="Review local education foundations"
					/></label
				><label
					>Mission keywords<input
						bind:value={mission}
						placeholder="youth, literacy, access"
					/></label
				><label>Geography<input bind:value={geography} placeholder="Phoenix, Arizona" /></label
				><label
					>Comparable charities<input
						bind:value={comparableCharities}
						placeholder="Similar organizations to compare"
					/></label
				><label
					>Known trustees or board members<input
						bind:value={knownTrustees}
						placeholder="Names or organizations to disambiguate"
					/></label
				><label
					>Prospect types<input
						bind:value={prospectTypes}
						placeholder="Foundation, nonprofit, family fund"
					/></label
				><label
					>Research sources<select multiple bind:value={queue.sourceIds}
						>{#each model.sources.filter((s: any) => s.enabled && s.permittedUses.includes('research')) as source}<option
								value={source.id}>{source.name} · {source.licenseLabel}</option
							>{/each}</select
					></label
				>
				<div class="pair">
					<label
						>Assigned researcher<select bind:value={queue.assignedTo}
							><option value="">Unassigned</option>{#each model.members as member}<option
									value={member.id}>{member.name} · {member.role}</option
								>{/each}</select
						></label
					><label>Due date<input type="datetime-local" bind:value={queueDue} /></label>
				</div>
				<div class="pair">
					<label
						>Maximum budget, minor units<input
							type="number"
							min="0"
							bind:value={queue.budgetCapMinor}
						/></label
					><label>Currency<input maxlength="3" bind:value={queue.currency} /></label>
				</div>
				<button disabled={busy || !queue.sourceIds.length}>Queue manual review</button>
			</form>
			<h3>Research tasks</h3>
			{#each model.queue as task}<article class="task">
					<strong>{task.title}</strong><small
						>{task.status.replaceAll('_', ' ')} · Budget cap {task.currency}
						{task.budgetCapMinor}</small
					><small
						>{task.criteria?.missionKeywords || 'No mission keywords'} · {task.criteria
							?.geography || 'No geography'}</small
					>{#if task.criteria?.comparableCharities || task.criteria?.knownTrustees || task.criteria?.prospectTypes}<small
							>Comparables: {task.criteria?.comparableCharities || '—'} · Trustees: {task.criteria
								?.knownTrustees || '—'} · Types: {task.criteria?.prospectTypes || '—'}</small
						>{/if}<small
						>{model.members.find((m: any) => m.id === task.assignedTo)?.name || 'Unassigned'} · {task.dueAt
							? new Date(task.dueAt).toLocaleString()
							: 'No due date'}</small
					>{#if task.status === 'ready_for_review'}<label
							>Outcome / review note<textarea
								rows="2"
								bind:value={task.outcomeText}
								placeholder="Summary and disposition"></textarea></label
						>{/if}{#if task.status === 'queued' || task.status === 'in_progress' || task.status === 'ready_for_review'}<button
							class="task-action"
							disabled={busy}
							onclick={() => advanceQueue(task)}
							>{task.status === 'queued'
								? 'Start review'
								: task.status === 'in_progress'
									? 'Ready for review'
									: 'Complete task'}</button
						>{/if}
				</article>{:else}<p class="muted">No research is queued.</p>{/each}
		</section>
	</div>
	<div class="funnel">
		<h3>Prospect funnel</h3>
		<p class="muted">
			Current prospect counts exclude merged records. Transitions count recorded stage changes,
			including repeat transitions.
		</p>
		<table>
			<caption>Current pipeline by stage</caption><thead
				><tr><th scope="col">Stage</th><th scope="col">Prospects</th></tr></thead
			><tbody
				>{#each model.funnel as row}<tr
						><th scope="row">{row.stage.replaceAll('_', ' ')}</th><td>{row.count}</td></tr
					>{:else}<tr><td colspan="2">No prospects yet.</td></tr>{/each}</tbody
			>
		</table>
		<table>
			<caption>Recorded stage transitions</caption><thead
				><tr><th scope="col">From</th><th scope="col">To</th><th scope="col">Changes</th></tr
				></thead
			><tbody
				>{#each model.transitions as row}<tr
						><td>{(row.from || 'New').replaceAll('_', ' ')}</td><td
							>{row.to.replaceAll('_', ' ')}</td
						><td>{row.count}</td></tr
					>{:else}<tr><td colspan="3">No stage changes recorded.</td></tr>{/each}</tbody
			>
		</table>
	</div>
</section>

<style>
	.controls {
		margin: 30px 0;
		padding: 22px 0;
		border-top: 1px solid var(--line, #dce3dd);
		color: var(--ink, #17251f);
	}
	.eyebrow {
		font-size: 9px;
		letter-spacing: 0.14em;
		color: var(--muted, #66736c);
	}
	h2 {
		font:
			24px Georgia,
			serif;
		margin: 7px 0;
	}
	h3 {
		font:
			19px Georgia,
			serif;
		margin: 24px 0 7px;
	}
	h4 {
		margin: 0 0 10px;
		font-size: 12px;
	}
	.head p:not(.eyebrow),
	.columns section > p {
		font-size: 11px;
		color: var(--muted, #66736c);
	}
	.columns {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 34px;
	}
	.weights {
		display: flex;
		gap: 8px;
		align-items: end;
		flex-wrap: wrap;
	}
	.weights label {
		font-size: 10px;
		display: grid;
		gap: 4px;
		color: var(--muted, #66736c);
	}
	input,
	select,
	textarea {
		font: inherit;
		color: var(--ink, #17251f);
		background: var(--surface, #fff);
		border: 1px solid var(--line, #dce3dd);
		padding: 8px;
		max-width: 100%;
	}
	.weights input {
		width: 70px;
	}
	.columns button {
		border: 0;
		background: #315d48;
		color: white;
		padding: 10px 13px;
		font-size: 10px;
		cursor: pointer;
	}
	.source,
	.task {
		display: grid;
		gap: 5px;
		padding: 11px 0;
		border-bottom: 1px solid var(--line, #dce3dd);
	}
	.source strong,
	.task strong {
		font-size: 11px;
	}
	.source small,
	.task small {
		font-size: 9px;
		color: var(--muted, #66736c);
	}
	.source a {
		font-size: 10px;
		color: #315d48;
	}
	.source-form,
	.queue-form,
	.import-form {
		margin-top: 14px;
		padding: 15px;
		background: var(--surface-muted, #f5f6f2);
		display: grid;
		gap: 10px;
	}
	.source-form > label,
	.queue-form > label,
	.import-form > label,
	.pair label {
		font-size: 10px;
		display: grid;
		gap: 5px;
		color: var(--muted, #66736c);
	}
	.pair {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 10px;
	}
	.source-form fieldset {
		border: 1px solid var(--line, #dce3dd);
		display: flex;
		gap: 9px;
		flex-wrap: wrap;
	}
	.source-form legend {
		font-size: 10px;
	}
	.check {
		display: flex;
		gap: 5px;
		align-items: center;
		font-size: 10px;
	}
	.queue-form select[multiple] {
		min-height: 90px;
	}
	.import-preview {
		margin-top: 12px;
		border-top: 1px solid var(--line, #dce3dd);
		padding-top: 10px;
	}
	.review-row {
		display: grid;
		grid-template-columns: auto 1fr;
		gap: 9px;
		padding: 9px 0;
		border-bottom: 1px solid var(--line, #dce3dd);
		align-items: start;
	}
	.review-row span {
		display: grid;
		gap: 4px;
	}
	.review-row strong {
		font-size: 11px;
	}
	.review-row small {
		font-size: 9px;
		color: var(--muted, #66736c);
	}
	.funnel {
		margin-top: 22px;
	}
	.funnel table {
		width: 100%;
		border-collapse: collapse;
		text-align: left;
		font-size: 11px;
	}
	.funnel td,
	.funnel th {
		padding: 8px;
		border-bottom: 1px solid var(--line, #dce3dd);
	}
	.muted {
		font-size: 10px;
		color: var(--muted, #66736c);
	}
	.error {
		color: #9d3d36;
		font-size: 11px;
	}
	.notice {
		color: #35634b;
		font-size: 11px;
	}
	@media (max-width: 760px) {
		.columns {
			grid-template-columns: 1fr;
		}
		.weights {
			align-items: stretch;
		}
		.pair {
			grid-template-columns: 1fr;
		}
	}
</style>
