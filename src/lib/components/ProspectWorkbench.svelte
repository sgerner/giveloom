<script lang="ts">
	import { onMount } from 'svelte';
	import ResearchControls from './ResearchControls.svelte';
	import { scoreProspect, defaultScoreWeights } from '$lib/intelligence-scoring';
	let {
		tenant,
		workspace,
		onChanged = () => {}
	} = $props<{ tenant: string; workspace: any; onChanged?: () => void }>();
	let query = $state(''),
		stage = $state('all'),
		notice = $state(''),
		error = $state(''),
		busy = $state(false),
		controls = $state<any[]>([]),
		controlReason = $state(''),
		weights = $state<any>({ ...defaultScoreWeights }),
		mergeTargetId = $state('');
	const stages = [
		'discovered',
		'screened',
		'qualified',
		'assigned',
		'introduction_requested',
		'contacted',
		'meeting',
		'solicited',
		'committed',
		'donated',
		'stewarded',
		'rejected'
	];
	let prospects = $derived(
		(workspace?.prospects || []).filter(
			(p: any) =>
				!p.mergedInto &&
				(stage === 'all' || p.stage === stage) &&
				String(p.name).toLowerCase().includes(query.toLowerCase())
		)
	);
	let mergedProspects = $derived(
		(workspace?.prospects || []).filter(
			(p: any) => p.mergedInto && String(p.name).toLowerCase().includes(query.toLowerCase())
		)
	);
	async function review(p: any, decision: 'accepted' | 'rejected') {
		await researchAction('review', {
			review: { prospectId: p.id, decision, reason: controlReason || 'Staff batch review' }
		});
	}
	async function merge(p: any) {
		if (!mergeTargetId) return;
		await researchAction('merge', {
			merge: {
				primaryId: mergeTargetId,
				duplicateId: p.id,
				reason: controlReason || 'Staff confirmed duplicate'
			}
		});
		mergeTargetId = '';
	}
	async function split(p: any) {
		await researchAction('split', {
			split: { prospectId: p.id, reason: controlReason || 'Staff corrected identity match' }
		});
	}
	async function researchAction(action: string, payload: any) {
		busy = true;
		error = '';
		try {
			const r = await fetch('/api/v1/research/workbench', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ tenant, action, ...payload })
			});
			const v = await r.json();
			if (!r.ok) throw new Error(v.error);
			notice = 'Prospect review was saved with an audit record.';
			onChanged();
			await loadControls();
		} catch (e) {
			error = e instanceof Error ? e.message : 'Review action failed.';
		} finally {
			busy = false;
		}
	}
	async function exportLicensed() {
		error = '';
		try {
			const r = await fetch('/api/v1/research/export?tenant=' + encodeURIComponent(tenant));
			if (!r.ok) {
				const v = await r.json();
				throw new Error(v.error);
			}
			const blob = await r.blob();
			const a = document.createElement('a');
			a.href = URL.createObjectURL(blob);
			a.download = 'licensed-prospects.csv';
			a.click();
			URL.revokeObjectURL(a.href);
			notice = `Exported ${r.headers.get('x-exported-records') || 0} licensed records.`;
		} catch (e) {
			error = e instanceof Error ? e.message : 'Export failed.';
		}
	}
	async function loadControls() {
		try {
			const r = await fetch('/api/v1/research/workbench?tenant=' + encodeURIComponent(tenant));
			const v = await r.json();
			controls = v.controls || [];
			weights = v.weights || { ...defaultScoreWeights };
		} catch {
			controls = [];
		}
	}
	onMount(loadControls);
	const controlFor = (id: string) => controls.find((x: any) => x.prospectId === id);
	async function update(p: any, key: string, value: any) {
		if (key !== 'stage') return;
		await researchAction('stage', {
			stage: { prospectId: p.id, stage: value, reason: controlReason || 'Pipeline stage review' }
		});
	}
	async function setControl(p: any, excluded: boolean, optedOut: boolean) {
		busy = true;
		error = '';
		try {
			const r = await fetch('/api/v1/research/workbench', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					tenant,
					action: 'control',
					control: { prospectId: p.id, excluded, optedOut, reason: controlReason || 'Staff review' }
				})
			});
			const v = await r.json();
			if (!r.ok) throw new Error(v.error);
			controls = [...controls.filter((x: any) => x.prospectId !== p.id), v.control];
			notice = 'Research exclusion updated and recorded.';
			controlReason = '';
		} catch (e) {
			error = e instanceof Error ? e.message : 'Research control could not be saved.';
		} finally {
			busy = false;
		}
	}
</script>

<section class="workbench" aria-labelledby="prospect-title">
	<header>
		<div>
			<p class="eyebrow">DISCOVER · EVIDENCE BEFORE OUTREACH</p>
			<h1 id="prospect-title">Research with care<span>.</span></h1>
			<p>
				Public filings can show trustees and grants. They do not establish an individual’s giving or
				permission to contact.
			</p>
		</div>
		<div class="count"><strong>{prospects.length}</strong><small>candidates in view</small></div>
	</header>
	{#if error}<p role="alert" class="message error">{error}</p>{/if}{#if notice}<p
			role="status"
			class="message"
		>
			{notice}
		</p>{/if}
	<div class="toolbar">
		<label class="search"
			>Search research<input bind:value={query} placeholder="Name or organization" /></label
		><label
			>Pipeline stage<select bind:value={stage}
				><option value="all">All stages</option>{#each stages as item}<option value={item}
						>{item.replaceAll('_', ' ')}</option
					>{/each}</select
			></label
		><span class="policy">No bulk contact from public records</span><button
			class="export"
			onclick={exportLicensed}>Export licensed prospects</button
		>
	</div>
	<div class="rows">
		{#each prospects as p (p.id)}{@const status = controlFor(p.id)}{@const scored = scoreProspect(
				p.scoreFeatures || p.features || {},
				weights
			)}
			<article class="prospect">
				<div class="identity">
					<small
						>{p.recordType || 'Research candidate'} · {p.stage?.replaceAll('_', ' ') ||
							'discovered'}{#if status?.excluded}<span class="flag">Excluded</span
							>{/if}{#if status?.optedOut}<span class="flag">Opted out</span>{/if}</small
					>
					<h2>{p.name}</h2>
					<p>
						{p.reason ||
							'Review the source record and decide whether further research is appropriate.'}
					</p>
					{#if status?.reason}<small>Control note: {status.reason}</small>{/if}
				</div>
				<div class="score">
					<strong>{scored.score ?? p.score ?? '—'}<small>/100</small></strong><span
						>explainable priority suggestion</span
					>{#if p.scoreFeatures || p.features}<meter
							min="0"
							max="1"
							value={scored.confidence}
							aria-label="Evidence coverage"
						></meter><small>{Math.round(scored.confidence * 100)}% evidence coverage</small
						>{#each scored.contributions.filter((x: any) => x.observed) as item}<small
								>{item.feature}: +{item.contribution} ({item.weight}% weight)</small
							>{/each}{:else if p.confidence !== undefined}<meter
							min="0"
							max="1"
							value={p.confidence}
							aria-label="Evidence coverage"
						></meter><small>{Math.round(p.confidence * 100)}% evidence coverage</small>{/if}
				</div>
				<div class="evidence">
					<strong>Source trail</strong>{#each p.evidence || [] as item}<a
							href={item.sourceUrl}
							target="_blank"
							rel="noreferrer">{item.sourceName || 'Source record'} ↗</a
						><small
							>{item.observedAt || p.filingYear || 'Date not recorded'} · {item.confidence ||
								'unverified'} · {item.sourceLicense || item.license || 'License not registered'} · {(
								item.permittedUses || []
							).join(', ') || 'Permitted uses not recorded'}</small
						>{:else}<small
							>No source attached yet. Add reviewed provenance before qualification.</small
						>{/each}<small class="caveat">Affiliation is not a personal connection.</small>
				</div>
				<div class="actions">
					<label
						>Stage<select
							value={p.stage || 'discovered'}
							disabled={busy || status?.excluded || status?.optedOut}
							onchange={(e) => update(p, 'stage', e.currentTarget.value)}
							>{#each stages as item}<option value={item}>{item.replaceAll('_', ' ')}</option
								>{/each}</select
						></label
					><a href={'/app/' + encodeURIComponent(tenant) + '/prospects/' + p.id}>Open profile →</a
					><label
						>Reason for control<input
							bind:value={controlReason}
							placeholder="Staff review note"
						/></label
					><button
						class="quiet"
						disabled={busy}
						onclick={() => setControl(p, !status?.excluded, Boolean(status?.optedOut))}
						>{status?.excluded ? 'Restore to research' : 'Exclude from research'}</button
					><button
						class="quiet"
						disabled={busy}
						onclick={() => setControl(p, Boolean(status?.excluded), !status?.optedOut)}
						>{status?.optedOut ? 'Clear opt-out' : 'Record opt-out'}</button
					>
					<div class="review-actions">
						<button class="quiet" disabled={busy} onclick={() => review(p, 'accepted')}
							>Accept for screening</button
						><button class="quiet" disabled={busy} onclick={() => review(p, 'rejected')}
							>Reject with reason</button
						><select bind:value={mergeTargetId} aria-label="Canonical prospect for merge"
							><option value="">Possible duplicate of…</option
							>{#each prospects.filter((candidate: any) => candidate.id !== p.id) as candidate}<option
									value={candidate.id}>{candidate.name}</option
								>{/each}</select
						><button class="quiet" disabled={busy || !mergeTargetId} onclick={() => merge(p)}
							>Merge into selected</button
						>{#if p.mergedInto}<button class="quiet" disabled={busy} onclick={() => split(p)}
								>Undo merge / split</button
							>{/if}
					</div>
				</div>
			</article>{:else}<div class="empty">
				<strong>No candidates match these filters.</strong>
				<p>Adjust the search or review a source before adding a candidate.</p>
			</div>{/each}
	</div>
	{#if mergedProspects.length}<section class="merged-records" aria-labelledby="merged-title">
			<h2 id="merged-title">Merged candidate records</h2>
			<p>Records stay available for audit and can be split if a match was incorrect.</p>
			{#each mergedProspects as p (p.id)}<article>
					<div>
						<strong>{p.name}</strong><small>
							Merged into {workspace.prospects.find(
								(candidate: any) => candidate.id === p.mergedInto
							)?.name || 'another candidate'}</small
						>
					</div>
					<button class="quiet" disabled={busy} onclick={() => split(p)}>Undo merge / split</button>
				</article>{/each}
		</section>{/if}
	<ResearchControls {tenant} onChanged={loadControls} />
</section>

<style>
	.workbench {
		padding: 24px 0;
		color: var(--ink, #17251f);
	}
	header {
		display: flex;
		justify-content: space-between;
		gap: 24px;
		align-items: end;
		padding: 12px 0 28px;
		border-bottom: 1px solid var(--line, #dce3dd);
	}
	.eyebrow {
		font-size: 10px;
		letter-spacing: 0.14em;
		color: var(--muted, #66736c);
	}
	h1 {
		font:
			500 clamp(34px, 5vw, 54px)/1.02 Georgia,
			serif;
		margin: 12px 0;
	}
	h1 span {
		color: #df7055;
	}
	header p:not(.eyebrow) {
		max-width: 620px;
		color: var(--muted, #66736c);
		font-size: 13px;
	}
	.count {
		text-align: right;
	}
	.count strong {
		font:
			44px Georgia,
			serif;
		display: block;
	}
	.count small,
	.score span {
		color: var(--muted, #66736c);
		font-size: 10px;
	}
	.toolbar {
		display: flex;
		align-items: end;
		gap: 16px;
		padding: 18px 0;
		border-bottom: 1px solid var(--line, #dce3dd);
	}
	label {
		display: grid;
		gap: 6px;
		font-size: 11px;
		color: var(--muted, #66736c);
	}
	input,
	select {
		font: inherit;
		color: var(--ink, #17251f);
		background: var(--surface, #fff);
		border: 0;
		border-bottom: 1px solid var(--line, #aab7ad);
		padding: 9px 4px;
		min-width: 180px;
	}
	.search {
		flex: 1;
	}
	.policy {
		margin-left: auto;
		color: #39624e;
		font-size: 11px;
	}
	.rows {
		display: grid;
	}
	.prospect {
		display: grid;
		grid-template-columns: minmax(200px, 1.6fr) minmax(100px, 0.55fr) minmax(180px, 1fr) minmax(
				140px,
				0.7fr
			);
		gap: 24px;
		padding: 22px 0;
		border-bottom: 1px solid var(--line, #dce3dd);
		align-items: start;
	}
	.identity small,
	.evidence small {
		font-size: 10px;
		color: var(--muted, #66736c);
	}
	h2 {
		font:
			500 22px Georgia,
			serif;
		margin: 8px 0;
	}
	.identity p {
		font-size: 12px;
		line-height: 1.55;
		margin: 0;
	}
	.score strong {
		font:
			32px Georgia,
			serif;
		display: block;
	}
	.score strong small {
		font: 12px sans-serif;
		color: var(--muted, #66736c);
	}
	.score meter {
		width: 90%;
		height: 5px;
		display: block;
		margin-top: 12px;
	}
	.evidence {
		display: grid;
		gap: 6px;
		font-size: 11px;
	}
	.evidence a {
		color: inherit;
		text-decoration-color: #d47d5d;
	}
	.evidence .caveat {
		margin-top: 6px;
		color: #95543e;
	}
	.actions {
		display: grid;
		gap: 14px;
	}
	.actions a {
		color: inherit;
		font-size: 11px;
	}
	.empty {
		padding: 50px 0;
		text-align: center;
	}
	.empty p {
		color: var(--muted, #66736c);
		font-size: 12px;
	}
	.message {
		padding: 10px 0;
		color: #35634b;
		font-size: 12px;
	}
	.error {
		color: #9d3d36;
	}
	.flag {
		display: inline-block;
		font-size: 9px;
		padding: 3px 6px;
		margin-left: 5px;
		background: #f1e7d8;
		color: #875834;
	}
	.actions .quiet {
		background: none;
		border: 0;
		padding: 3px;
		text-align: left;
		text-decoration: underline;
		color: #3e634d;
		font-size: 10px;
		cursor: pointer;
	}
	.actions .quiet:disabled {
		opacity: 0.5;
	}
	.export {
		border: 0;
		background: #315d48;
		color: white;
		padding: 9px 12px;
		cursor: pointer;
		font-size: 10px;
	}
	.review-actions {
		display: grid;
		gap: 6px;
	}
	.review-actions select {
		min-width: 0;
		font-size: 10px;
	}
	.merged-records {
		margin: 24px 0;
		padding: 16px;
		background: var(--surface-muted, #f5f6f2);
	}
	.merged-records > p,
	.merged-records small {
		font-size: 10px;
		color: var(--muted, #66736c);
	}
	.merged-records article {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 9px 0;
		border-top: 1px solid var(--line, #dce3dd);
	}
	.merged-records article div {
		display: grid;
		gap: 3px;
	}
	.merged-records button {
		border: 0;
		background: none;
		text-decoration: underline;
		color: #3e634d;
		cursor: pointer;
	}
	@media (max-width: 850px) {
		.prospect {
			grid-template-columns: 1fr 100px;
			gap: 16px;
		}
		.evidence,
		.actions {
			grid-column: 1/-1;
		}
		.toolbar {
			flex-wrap: wrap;
		}
		.policy {
			margin-left: 0;
		}
	}
	@media (max-width: 520px) {
		header {
			align-items: start;
		}
		.count strong {
			font-size: 32px;
		}
		.toolbar label,
		.search {
			width: 100%;
		}
		.toolbar input,
		.toolbar select {
			width: 100%;
		}
		.prospect {
			grid-template-columns: 1fr;
		}
		.evidence,
		.actions {
			grid-column: auto;
		}
	}
</style>
