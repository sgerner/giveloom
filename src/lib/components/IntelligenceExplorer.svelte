<script lang="ts">
	import { onMount } from 'svelte';
	let {
		tenant,
		workspace,
		onChanged = () => {}
	} = $props<{ tenant: string; workspace: any; onChanged?: () => void }>();
	let fromId = $state(''),
		toId = $state(''),
		depth = $state(2),
		paths = $state<any[]>([]),
		edges = $state<any[]>([]),
		remoteNodes = $state<any[]>([]),
		edgeCursor = $state<string | null>(null),
		nodeSearch = $state(''),
		nodeSearchTimer: ReturnType<typeof setTimeout> | undefined,
		selected = $state<any>(null),
		error = $state(''),
		notice = $state(''),
		busy = $state(false),
		transitionNote = $state(''),
		edgeType = $state('all'),
		confidenceFloor = $state('possible'),
		panX = $state(0),
		panY = $state(0),
		zoom = $state(1),
		drag = $state<any>(null),
		edgeHistory = $state<any[]>([]),
		sources = $state<any[]>([]),
		members = $state<any[]>([]),
		dateFrom = $state(''),
		dateTo = $state(''),
		pathEvidenceType = $state('all'),
		pathSourceId = $state(''),
		nodeType = $state('all'),
		requestPath = $state<any>(null),
		introForm = $state<any>({ title: '', ownerId: '', dueAt: '', notes: '' }),
		correction = $state<any>({
			provenanceLabel: '',
			sourceUrl: '',
			evidenceType: 'other',
			confidence: 'medium',
			privacyScope: 'tenant'
		}),
		edgeForm = $state<any>({
			fromId: '',
			toId: '',
			kind: 'trustee_of',
			evidenceType: 'public_filing',
			provenanceLabel: '',
			sourceUrl: '',
			observedAt: '',
			confidence: 'medium',
			privacyScope: 'public_source',
			sourceId: ''
		});
	const nodeKind = (record: any, fallback: string) => {
		const raw = String(
			record?.nodeType || record?.recordType || record?.type || fallback
		).toLowerCase();
		return [
			'person',
			'household',
			'organization',
			'employer',
			'nonprofit',
			'foundation',
			'school',
			'board',
			'event'
		].includes(raw)
			? raw
			: fallback;
	};
	const workspaceNodes = $derived([
		...(workspace?.contacts || []).map((n: any) => ({ ...n, nodeKind: nodeKind(n, 'person') })),
		...(workspace?.prospects || []).map((n: any) => ({
			...n,
			nodeKind: nodeKind(
				n,
				String(n.recordType || 'person')
					.toLowerCase()
					.includes('foundation')
					? 'foundation'
					: String(n.recordType || '')
								.toLowerCase()
								.includes('organization')
						? 'organization'
						: 'person'
			)
		})),
		...(workspace?.organizations || []).map((n: any) => ({
			...n,
			nodeKind: nodeKind(n, 'organization')
		})),
		...(workspace?.households || []).map((n: any) => ({ ...n, nodeKind: 'household' })),
		...(workspace?.events || []).map((n: any) => ({ ...n, nodeKind: 'event' }))
	]);
	const nodes = $derived([
		...new Map([...workspaceNodes, ...remoteNodes].map((n: any) => [n.id, n])).values()
	]);
	const visibleEdges = $derived(
		edges.filter(
			(edge: any) =>
				!edge.archivedAt &&
				(edgeType === 'all' || edge.kind === edgeType) &&
				['confirmed', 'high', 'medium', 'low', 'possible'].indexOf(edge.confidence || 'possible') <=
					['confirmed', 'high', 'medium', 'low', 'possible'].indexOf(confidenceFloor) &&
				(nodeType === 'all' ||
					[
						edge.fromNodeType || nodes.find((n: any) => n.id === edge.fromId)?.nodeKind,
						edge.toNodeType || nodes.find((n: any) => n.id === edge.toId)?.nodeKind
					].includes(nodeType))
		)
	);
	const graphNodeIds = $derived([...new Set(visibleEdges.flatMap((e: any) => [e.fromId, e.toId]))]);
	const label = (id: string) => nodes.find((n: any) => n.id === id)?.name || 'Unknown record';
	const point = (id: string) => {
		const i = graphNodeIds.indexOf(id),
			n = Math.max(graphNodeIds.length, 1),
			angle = (Math.PI * 2 * i) / n - Math.PI / 2;
		return {
			x: 400 + Math.cos(angle) * Math.min(280, 85 + n * 12),
			y: 180 + Math.sin(angle) * 110
		};
	};
	function panStart(e: PointerEvent) {
		if ((e.target as Element).closest('.graph-node')) return;
		drag = { x: e.clientX, y: e.clientY };
		(e.currentTarget as SVGSVGElement).setPointerCapture(e.pointerId);
	}
	function panMove(e: PointerEvent) {
		if (!drag) return;
		panX += e.clientX - drag.x;
		panY += e.clientY - drag.y;
		drag = { x: e.clientX, y: e.clientY };
	}
	async function loadEdges(append = false) {
		try {
			const params = new URLSearchParams({ tenant, limit: '200' });
			if (append && edgeCursor) params.set('cursor', edgeCursor);
			const r = await fetch('/api/v1/relationships/evidence?' + params);
			const v = await r.json();
			if (!r.ok) throw new Error(v.error);
			edges = append ? [...edges, ...(v.edges || [])] : v.edges || [];
			remoteNodes = append ? [...remoteNodes, ...(v.nodes || [])] : v.nodes || [];
			edgeCursor = v.nextCursor || null;
			if (!append) {
				const wr = await fetch('/api/v1/research/workbench?tenant=' + encodeURIComponent(tenant));
				const w = await wr.json();
				if (wr.ok) {
					sources = w.sources || [];
					members = w.members || [];
				}
			}
		} catch (e) {
			error = e instanceof Error ? e.message : 'Relationship evidence unavailable.';
		}
	}
	function searchNodes() {
		clearTimeout(nodeSearchTimer);
		nodeSearchTimer = setTimeout(async () => {
			try {
				const params = new URLSearchParams({ tenant, limit: '1', nodeQuery: nodeSearch.trim() });
				const r = await fetch('/api/v1/relationships/evidence?' + params);
				const v = await r.json();
				if (r.ok)
					remoteNodes = [
						...new Map([...remoteNodes, ...(v.nodes || [])].map((n: any) => [n.id, n])).values()
					].slice(-200);
			} catch {
				/* current page nodes remain selectable */
			}
		}, 250);
	}
	async function inspect(edge: any) {
		selected = edge;
		edgeHistory = [];
		try {
			const r = await fetch(
				`/api/v1/relationships/evidence/${encodeURIComponent(edge.id)}/lifecycle?tenant=${encodeURIComponent(tenant)}`
			);
			const v = await r.json();
			if (r.ok) edgeHistory = v.events || [];
		} catch {
			/* evidence remains inspectable if audit history is temporarily unavailable */
		}
	}
	onMount(loadEdges);
	async function findPaths() {
		error = '';
		paths = [];
		if (!fromId || !toId) return;
		busy = true;
		try {
			const r = await fetch('/api/v1/relationships/paths', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					tenant,
					fromId,
					toId,
					depth,
					...(dateFrom ? { dateFrom } : {}),
					...(dateTo ? { dateTo } : {}),
					...(pathEvidenceType !== 'all' ? { evidenceType: pathEvidenceType } : {}),
					...(pathSourceId ? { sourceId: pathSourceId } : {}),
					confidenceAtLeast: confidenceFloor
				})
			});
			const v = await r.json();
			if (!r.ok) throw new Error(v.error);
			paths = v.paths || [];
			if (!paths.length) notice = 'No evidence-backed path found at this depth.';
		} catch (e) {
			error = e instanceof Error ? e.message : 'Path search failed.';
		} finally {
			busy = false;
		}
	}
	async function addEdge(e: SubmitEvent) {
		e.preventDefault();
		error = '';
		notice = '';
		busy = true;
		try {
			const payload = {
				tenant,
				...edgeForm,
				...(edgeForm.observedAt ? { observedAt: new Date(edgeForm.observedAt).toISOString() } : {})
			};
			const r = await fetch('/api/v1/relationships/evidence', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ ...payload, sourceId: edgeForm.sourceId || undefined })
			});
			const v = await r.json();
			if (!r.ok) throw new Error(v.error);
			edgeForm = { ...edgeForm, provenanceLabel: '', sourceUrl: '', observedAt: '' };
			notice = 'Connection saved with its source and uncertainty.';
			await loadEdges();
			onChanged();
		} catch (e) {
			error = e instanceof Error ? e.message : 'Evidence could not be saved.';
		} finally {
			busy = false;
		}
	}
	const stages = [
		'proposed',
		'internal_review',
		'donor_asked',
		'donor_consented',
		'draft_prepared',
		'sent_by_donor',
		'meeting',
		'qualified',
		'donated',
		'closed'
	];
	async function createIntroduction() {
		if (!requestPath) return;
		const donor = nodes.find((n: any) => n.id === fromId),
			candidate = nodes.find((n: any) => n.id === toId);
		if (
			!donor ||
			donor.nodeKind !== 'person' ||
			!(
				donor.sourceResource === 'contacts' ||
				workspace?.contacts?.some((c: any) => c.id === fromId)
			) ||
			!candidate ||
			!(
				candidate.sourceResource === 'prospects' ||
				workspace?.prospects?.some((p: any) => p.id === toId)
			)
		) {
			error = 'Choose a known supporter and a managed prospect.';
			return;
		}
		busy = true;
		error = '';
		try {
			const r = await fetch('/api/v1/introductions', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					tenant,
					contactId: fromId,
					prospectId: toId,
					title: introForm.title || `Ask ${donor.name} about ${candidate.name}`,
					notes: introForm.notes,
					ownerId: introForm.ownerId || undefined,
					dueAt: introForm.dueAt ? new Date(introForm.dueAt).toISOString() : undefined
				})
			});
			const v = await r.json();
			if (!r.ok) throw new Error(v.error);
			notice = 'Introduction request created for internal review.';
			requestPath = null;
			introForm = { title: '', ownerId: '', dueAt: '', notes: '' };
			onChanged();
		} catch (e) {
			error = e instanceof Error ? e.message : 'Introduction request could not be created.';
		} finally {
			busy = false;
		}
	}
	async function advance(intro: any) {
		error = '';
		notice = '';
		busy = true;
		try {
			const next = stages[stages.indexOf(intro.stage || 'proposed') + 1];
			if (!next) throw new Error('This introduction has reached its final stage.');
			const r = await fetch('/api/v1/introductions/transition', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					tenant,
					id: intro.id,
					stage: next,
					note: transitionNote,
					ownerId: intro.ownerId || undefined,
					dueAt: intro.dueAt || undefined,
					outcome: intro.outcome || undefined
				})
			});
			const v = await r.json();
			if (!r.ok) throw new Error(v.error);
			notice = `Introduction moved to ${next.replaceAll('_', ' ')}.`;
			transitionNote = '';
			onChanged();
		} catch (e) {
			error = e instanceof Error ? e.message : 'Transition failed.';
		} finally {
			busy = false;
		}
	}
	async function lifecycle(action: string) {
		if (!selected?.id) return;
		error = '';
		busy = true;
		try {
			const r = await fetch(
				`/api/v1/relationships/evidence/${encodeURIComponent(selected.id)}/lifecycle`,
				{
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({
						tenant,
						action,
						note: transitionNote,
						...(action === 'correct' ? { correction } : {})
					})
				}
			);
			const v = await r.json();
			if (!r.ok) throw new Error(v.error);
			notice =
				action === 'correct'
					? 'A corrected evidence version was created; the previous version is marked stale.'
					: `Evidence marked ${action.replaceAll('_', ' ')}.`;
			transitionNote = '';
			if (action === 'correct')
				correction = {
					provenanceLabel: '',
					sourceUrl: '',
					evidenceType: 'other',
					confidence: 'medium',
					privacyScope: 'tenant'
				};
			await loadEdges();
			selected = null;
			onChanged();
		} catch (e) {
			error = e instanceof Error ? e.message : 'Evidence update failed.';
		} finally {
			busy = false;
		}
	}
</script>

<section class="explorer" aria-labelledby="relationship-title">
	<header>
		<div>
			<p class="eyebrow">RELATIONSHIPS · PROVENANCE FIRST</p>
			<h1 id="relationship-title">A path worth explaining<span>.</span></h1>
			<p>
				Shared affiliation can suggest a route to ask about. It never proves personal familiarity.
			</p>
		</div>
	</header>
	{#if error}<p role="alert" class="message error">{error}</p>{/if}{#if notice}<p
			role="status"
			class="message"
		>
			{notice}
		</p>{/if}
	<div class="path-search">
		<label
			>Find a graph record<input
				bind:value={nodeSearch}
				oninput={searchNodes}
				placeholder="Search any supporter, prospect, or organization"
			/></label
		><label
			>From<select bind:value={fromId}
				><option value="">Choose a supporter</option>{#each nodes as n}<option value={n.id}
						>{n.name} · {n.nodeKind}</option
					>{/each}</select
			></label
		><span aria-hidden="true">→</span><label
			>To<select bind:value={toId}
				><option value="">Choose a candidate</option>{#each nodes as n}<option value={n.id}
						>{n.name} · {n.nodeKind}</option
					>{/each}</select
			></label
		><label
			>Maximum steps<select bind:value={depth}
				><option value={1}>1</option><option value={2}>2</option><option value={3}>3</option
				></select
			></label
		><label>Observed from<input type="date" bind:value={dateFrom} /></label><label
			>Observed through<input type="date" bind:value={dateTo} /></label
		><label
			>Evidence type<select bind:value={pathEvidenceType}
				><option value="all">All evidence</option
				>{#each ['public_filing', 'organization_page', 'tenant_note', 'donor_confirmed', 'other'] as type}<option
						value={type}>{type.replaceAll('_', ' ')}</option
					>{/each}</select
			></label
		><label
			>Registered source<select bind:value={pathSourceId}
				><option value="">Any source</option>{#each sources as source}<option value={source.id}
						>{source.name} · {source.licenseLabel}</option
					>{/each}</select
			></label
		><button class="primary" disabled={busy || !fromId || !toId} onclick={findPaths}
			>{busy ? 'Looking…' : 'Find documented paths'}</button
		>
	</div>
	<div class="path-results" aria-live="polite">
		{#each paths as path, index}<article>
				<small>PATH {index + 1} · {path.length} {path.length === 1 ? 'step' : 'steps'}</small>
				<p>
					{#each path as edge}<span
							>{label(edge.fromId)} — {String(edge.kind).replaceAll('_', ' ')}
							<i>({edge.confidence || 'unverified'})</i>
							→ {label(edge.toId)}<br /><small
								>{edge.sourceName || 'Unregistered source'} · {edge.sourceLicense ||
									'Permitted uses not recorded'} · {edge.observedAt || 'Date unknown'}</small
							>{#if edge.sourceUrl}<a href={edge.sourceUrl} target="_blank" rel="noreferrer"
									>Source ↗</a
								>{/if}<br /></span
						>{/each}
				</p>
				<button class="quiet" onclick={() => inspect(path[0])}>Inspect evidence</button
				>{#if (nodes.find((n: any) => n.id === fromId)?.sourceResource === 'contacts' || workspace?.contacts?.some((c: any) => c.id === fromId)) && (nodes.find((n: any) => n.id === toId)?.sourceResource === 'prospects' || workspace?.prospects?.some((p: any) => p.id === toId))}<button
						class="quiet"
						onclick={() => {
							requestPath = path;
							introForm = {
								title: `Ask ${label(fromId)} about ${label(toId)}`,
								ownerId: '',
								dueAt: '',
								notes: ''
							};
						}}>Request an introduction</button
					>{/if}{#if requestPath === path}<form
						class="intro-request"
						onsubmit={(e) => {
							e.preventDefault();
							void createIntroduction();
						}}
					>
						<label>Request title<input required bind:value={introForm.title} /></label><label
							>Internal context<textarea rows="2" bind:value={introForm.notes}></textarea></label
						>
						<div class="consent-input">
							<label
								>Owner<select bind:value={introForm.ownerId}
									><option value="">Unassigned</option>{#each members as member}<option
											value={member.id}>{member.name} · {member.role}</option
										>{/each}</select
								></label
							><label>Due date<input type="datetime-local" bind:value={introForm.dueAt} /></label>
						</div>
						<button class="primary" disabled={busy}>Create internal request</button>
					</form>{/if}
			</article>{:else}<p class="empty">
				Choose a supporter and candidate to explore evidence-backed routes.
			</p>{/each}
	</div>
	<section class="graph" aria-labelledby="graph-title">
		<div class="graph-head">
			<div>
				<p class="eyebrow">NETWORK VIEW</p>
				<h2 id="graph-title">Connections around your search</h2>
			</div>
			<div class="graph-controls">
				<label
					>Node type<select bind:value={nodeType}
						><option value="all">All node types</option
						>{#each ['person', 'household', 'organization', 'employer', 'nonprofit', 'foundation', 'school', 'board', 'event'] as type}<option
								value={type}>{type}</option
							>{/each}</select
					></label
				><label
					>Connection<select bind:value={edgeType}
						><option value="all">All types</option
						>{#each ['serves_on_board', 'works_at', 'trustee_of', 'grant_to', 'attended_with', 'known_by', 'introduced_by', 'family_relationship', 'donor_confirmed_connection', 'affiliation'] as type}<option
								value={type}>{type.replaceAll('_', ' ')}</option
							>{/each}</select
					></label
				><label
					>Confidence at least<select bind:value={confidenceFloor}
						><option value="possible">Possible</option><option value="low">Low</option><option
							value="medium">Medium</option
						><option value="high">High</option><option value="confirmed">Confirmed</option></select
					></label
				><button aria-label="Zoom out" onclick={() => (zoom = Math.max(0.6, zoom - 0.15))}>−</button
				><button aria-label="Zoom in" onclick={() => (zoom = Math.min(1.8, zoom + 0.15))}>+</button
				><button
					onclick={() => {
						zoom = 1;
						panX = 0;
						panY = 0;
					}}>Reset view</button
				>
			</div>
		</div>
		<p class="muted">
			Drag the canvas to pan. Stale or disputed evidence is dashed and excluded from path
			suggestions.
		</p>
		{#if edgeCursor}<button class="quiet" onclick={() => loadEdges(true)}
				>Load more graph evidence</button
			>{/if}<svg
			class="graph-canvas"
			viewBox="0 0 800 360"
			role="group"
			aria-label="Interactive evidence relationship graph; use the connections table for a linear view"
			onpointerdown={panStart}
			onpointermove={panMove}
			onpointerup={() => (drag = null)}
			onpointercancel={() => (drag = null)}
			><g
				transform={`translate(${panX} ${panY}) translate(400 180) scale(${zoom}) translate(-400 -180)`}
				>{#each visibleEdges as edge (edge.id)}{@const a = point(edge.fromId)}{@const b = point(
						edge.toId
					)}<line
						x1={a.x}
						y1={a.y}
						x2={b.x}
						y2={b.y}
						class:uncertain={edge.verificationStatus === 'stale' ||
							edge.verificationStatus === 'disputed'}
					/><text x={(a.x + b.x) / 2} y={(a.y + b.y) / 2 - 7} text-anchor="middle"
						>{String(edge.kind).replaceAll('_', ' ')}</text
					>{/each}{#each graphNodeIds as id (id)}{@const p = point(id)}<g
						class="graph-node"
						role="button"
						tabindex="0"
						aria-label={`Inspect ${label(id)}`}
						onclick={() => {
							const edge = visibleEdges.find((item: any) => item.fromId === id || item.toId === id);
							if (edge) inspect(edge);
						}}
						onkeydown={(e) => {
							if (e.key === 'Enter' || e.key === ' ') {
								e.preventDefault();
								const edge = visibleEdges.find(
									(item: any) => item.fromId === id || item.toId === id
								);
								if (edge) inspect(edge);
							}
						}}
						><circle cx={p.x} cy={p.y} r="22" /><text x={p.x} y={p.y + 38} text-anchor="middle"
							>{label(id).slice(0, 24)}</text
						></g
					>{/each}</g
			></svg
		>
		<details class="accessible-graph">
			<summary>View connections as a table</summary>
			<table>
				<caption>Filtered relationship evidence</caption><thead
					><tr
						><th>From</th><th>Connection</th><th>To</th><th>Confidence</th><th>Verification</th><th
							>Evidence</th
						></tr
					></thead
				><tbody
					>{#each visibleEdges as edge}<tr
							><td>{label(edge.fromId)}</td><td>{String(edge.kind).replaceAll('_', ' ')}</td><td
								>{label(edge.toId)}</td
							><td>{edge.confidence || 'possible'}</td><td
								>{edge.verificationStatus || 'unverified'}</td
							><td><button class="quiet" onclick={() => inspect(edge)}>Inspect evidence</button></td
							></tr
						>{:else}<tr><td colspan="6">No edges match these filters.</td></tr>{/each}</tbody
				>
			</table>
		</details>
	</section>
	<div class="lower">
		<section class="edge-list">
			<h2>Documented connections</h2>
			<p class="muted">Each edge keeps its source and uncertainty visible.</p>
			{#each edges as edge}<button class="edge" onclick={() => inspect(edge)}
					><span
						>{label(edge.fromId)} → {String(edge.kind).replaceAll('_', ' ')} → {label(
							edge.toId
						)}</span
					><small
						>{edge.confidence || 'possible'} · {edge.evidenceType || 'source unclassified'}</small
					></button
				>{:else}<p class="empty">No connections have been documented yet.</p>{/each}
			<form class="edge-form" onsubmit={addEdge}>
				<h3>Add sourced evidence</h3>
				<div class="consent-input">
					<label
						>From<select bind:value={edgeForm.fromId} required
							><option value="">Choose a record</option>{#each nodes as n}<option value={n.id}
									>{n.name}</option
								>{/each}</select
						></label
					><label
						>To<select bind:value={edgeForm.toId} required
							><option value="">Choose a record</option>{#each nodes as n}<option value={n.id}
									>{n.name}</option
								>{/each}</select
						></label
					>
				</div>
				<div class="consent-input">
					<label
						>Connection type<select bind:value={edgeForm.kind}
							>{#each ['serves_on_board', 'works_at', 'trustee_of', 'grant_to', 'attended_with', 'known_by', 'introduced_by', 'family_relationship', 'donor_confirmed_connection', 'affiliation'] as type}<option
									value={type}>{type.replaceAll('_', ' ')}</option
								>{/each}</select
						></label
					><label
						>Registered source<select bind:value={edgeForm.sourceId}
							><option value="">No license record</option>{#each sources as source}<option
									value={source.id}>{source.name} · {source.licenseLabel}</option
								>{/each}</select
						></label
					><label
						>Evidence kind<select bind:value={edgeForm.evidenceType}
							><option value="public_filing">Public filing</option><option value="organization_page"
								>Organization page</option
							><option value="tenant_note">Staff note</option><option value="donor_confirmed"
								>Donor confirmed</option
							><option value="other">Other</option></select
						></label
					>
				</div>
				<label
					>What does the evidence say?<input
						required
						minlength="3"
						bind:value={edgeForm.provenanceLabel}
						placeholder="2024 filing lists Alex as trustee"
					/></label
				>
				<div class="consent-input">
					<label
						>Source URL<input
							type="url"
							bind:value={edgeForm.sourceUrl}
							placeholder="https://…"
						/></label
					><label>Observed date<input type="date" bind:value={edgeForm.observedAt} /></label>
				</div>
				<div class="consent-input">
					<label
						>Confidence<select bind:value={edgeForm.confidence}
							><option>confirmed</option><option>high</option><option>medium</option><option
								>low</option
							><option>possible</option></select
						></label
					><label
						>Privacy<select bind:value={edgeForm.privacyScope}
							><option value="public_source">Public source</option><option value="tenant"
								>Tenant only</option
							><option value="restricted">Restricted</option></select
						></label
					>
				</div>
				<button class="primary" disabled={busy}>Save evidence</button>
			</form>
		</section>
		<aside class="evidence">
			{#if selected}<button
					class="close"
					onclick={() => {
						selected = null;
						edgeHistory = [];
					}}>Close ×</button
				>
				<p class="eyebrow">EVIDENCE RECORD</p>
				<h2>{String(selected.kind).replaceAll('_', ' ')}</h2>
				<p>{selected.evidence || selected.provenanceLabel || 'Evidence note missing.'}</p>
				{#if selected.sourceUrl || selected.provenanceUrl}<a
						href={selected.sourceUrl || selected.provenanceUrl}
						target="_blank"
						rel="noreferrer">Open source ↗</a
					>{/if}
				<dl>
					<dt>Confidence</dt>
					<dd>{selected.confidence || 'possible'}</dd>
					<dt>Verification</dt>
					<dd>{selected.verificationStatus || 'unverified'}</dd>
					<dt>Observed</dt>
					<dd>{selected.observedAt || selected.lastVerifiedAt || 'Not recorded'}</dd>
					<dt>Source license</dt>
					<dd>{selected.sourceLicense || 'Not registered'}</dd>
					<dt>Permitted uses</dt>
					<dd>{(selected.permittedUses || []).join(', ') || 'Not recorded'}</dd>
				</dl>
				<div class="lifecycle-actions">
					<button
						class="quiet"
						disabled={busy || selected.verificationStatus === 'verified'}
						onclick={() => lifecycle('verify')}>Verify</button
					><button
						class="quiet"
						disabled={busy || selected.verificationStatus === 'disputed'}
						onclick={() => lifecycle('dispute')}>Dispute</button
					><button
						class="quiet"
						disabled={busy || selected.verificationStatus === 'stale'}
						onclick={() => lifecycle('mark_stale')}>Mark stale</button
					><button
						class="quiet"
						disabled={busy || !!selected.archivedAt}
						onclick={() => lifecycle('archive')}>Archive</button
					>
				</div>
				<label
					>Audit note<input
						bind:value={transitionNote}
						maxlength="1000"
						placeholder="Why this evidence changed"
					/></label
				>
				<details>
					<summary>Correct this evidence</summary>
					<form
						class="correction-form"
						onsubmit={(e) => {
							e.preventDefault();
							lifecycle('correct');
						}}
					>
						<label
							>Corrected statement<input
								required
								minlength="3"
								bind:value={correction.provenanceLabel}
							/></label
						>
						<div class="consent-input">
							<label
								>Evidence kind<select bind:value={correction.evidenceType}
									><option value="public_filing">Public filing</option><option
										value="organization_page">Organization page</option
									><option value="tenant_note">Staff note</option><option value="donor_confirmed"
										>Donor confirmed</option
									><option value="other">Other</option></select
								></label
							><label
								>Confidence<select bind:value={correction.confidence}
									><option>confirmed</option><option>high</option><option>medium</option><option
										>low</option
									><option>possible</option></select
								></label
							>
						</div>
						<div class="consent-input">
							<label
								>Source URL<input
									type="url"
									bind:value={correction.sourceUrl}
									placeholder="https://…"
								/></label
							><label
								>Privacy<select bind:value={correction.privacyScope}
									><option value="public_source">Public source</option><option value="tenant"
										>Tenant only</option
									><option value="restricted">Restricted</option></select
								></label
							>
						</div>
						<button class="primary" disabled={busy}>Save corrected version</button>
					</form>
				</details>
				<details>
					<summary>Evidence history ({edgeHistory.length})</summary>{#each edgeHistory as event}<p
							class="history-event"
						>
							<strong>{event.action.replaceAll('_', ' ')}</strong> · {event.actorName || 'Staff'} · {new Date(
								event.createdAt
							).toLocaleString()}<br />{event.note || 'No note recorded.'}
						</p>{:else}<p>No lifecycle changes recorded.</p>{/each}
				</details>
				<p class="fine">
					Public affiliation does not establish personal acquaintance. Disputed or stale evidence
					should not drive an introduction request.
				</p>{:else}<div class="evidence-prompt">
					<strong>Select an edge</strong>
					<p>Its source, confidence, and verification status will appear here.</p>
				</div>{/if}
		</aside>
	</div>
	<section class="introductions">
		<div class="section-heading">
			<div>
				<p class="eyebrow">CONSENT-AWARE FOLLOW THROUGH</p>
				<h2>Introduction requests</h2>
			</div>
			<small
				>The donor responds in their authenticated portal; they send any draft personally.</small
			>
		</div>
		{#each workspace?.introductions || [] as intro}<article class="intro">
				<div>
					<small>{intro.stage?.replaceAll('_', ' ') || 'proposed'}</small>
					<h3>{intro.title || `Introduction to ${label(intro.prospectId)}`}</h3>
					<p>{label(intro.contactId)} · {label(intro.prospectId)}</p>
					<small
						>Owner: {members.find((m: any) => m.id === intro.ownerId)?.name || 'Unassigned'} · Due: {intro.dueAt
							? new Date(intro.dueAt).toLocaleString()
							: 'Not set'}</small
					>
				</div>
				<div class="next-step">
					<p>
						{intro.stage === 'donor_asked'
							? 'Waiting for the donor to respond in their authenticated portal.'
							: intro.stage === 'donor_consented'
								? 'Portal consent recorded. Prepare a draft for review.'
								: intro.stage === 'draft_prepared'
									? 'The donor sends the message from their own email.'
									: 'Move one reviewed staff step at a time.'}
					</p>
					{#if intro.stage !== 'donor_asked' && intro.stage !== 'donor_consented' && intro.stage !== 'closed' && intro.stage !== 'donated'}<label
							>Step note<input
								bind:value={transitionNote}
								placeholder="Context for the next owner"
							/></label
						><label
							>Owner<select bind:value={intro.ownerId}
								><option value="">Unassigned</option>{#each members as member}<option
										value={member.id}>{member.name}</option
									>{/each}</select
							></label
						><label
							>Due date<input
								type="datetime-local"
								value={intro.dueAt ? new Date(intro.dueAt).toISOString().slice(0, 16) : ''}
								oninput={(e) =>
									(intro.dueAt = e.currentTarget.value
										? new Date(e.currentTarget.value).toISOString()
										: null)}
							/></label
						><label
							>Outcome note<input
								bind:value={intro.outcome}
								placeholder="Outcome / follow-up"
							/></label
						><button class="primary" disabled={busy} onclick={() => advance(intro)}
							>Advance one step →</button
						>{/if}
				</div>
			</article>{:else}<p class="empty">No introduction requests are open.</p>{/each}
	</section>
</section>

<style>
	.explorer {
		padding: 24px 0;
		color: var(--ink, #17251f);
	}
	header {
		padding: 12px 0 26px;
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
	header p:not(.eyebrow),
	.muted {
		font-size: 12px;
		color: var(--muted, #66736c);
	}
	.path-search {
		display: flex;
		align-items: end;
		gap: 15px;
		padding: 22px 0;
		border-bottom: 1px solid var(--line, #dce3dd);
	}
	label {
		display: grid;
		gap: 6px;
		font-size: 10px;
		color: var(--muted, #66736c);
		flex: 1;
	}
	input,
	select {
		font: inherit;
		color: var(--ink, #17251f);
		background: var(--surface, #fff);
		border: 0;
		border-bottom: 1px solid var(--line, #aab7ad);
		padding: 9px 4px;
		min-width: 100px;
	}
	.primary {
		border: 0;
		background: #315d48;
		color: white;
		padding: 11px 15px;
		cursor: pointer;
		font-size: 11px;
	}
	.primary:disabled {
		opacity: 0.45;
		cursor: default;
	}
	.path-results {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
		gap: 16px;
	}
	.intro-request {
		display: grid;
		gap: 10px;
		padding: 14px;
		background: var(--surface-muted, #f4f6f1);
	}
	.path-results article {
		padding: 17px 0;
		border-bottom: 1px solid var(--line, #dce3dd);
	}
	.path-results small,
	.intro small {
		font-size: 9px;
		letter-spacing: 0.1em;
		color: var(--muted, #66736c);
	}
	.path-results p {
		font:
			17px/1.6 Georgia,
			serif;
	}
	.path-results span {
		color: #406c53;
	}
	.path-results i {
		font: italic 10px sans-serif;
		color: #925c48;
	}
	.quiet,
	.close {
		border: 0;
		background: none;
		padding: 4px 0;
		color: inherit;
		cursor: pointer;
		font-size: 10px;
		text-decoration: underline;
	}
	.lower {
		display: grid;
		grid-template-columns: 1.4fr 0.8fr;
		gap: 36px;
		border-top: 1px solid var(--line, #dce3dd);
		border-bottom: 1px solid var(--line, #dce3dd);
		padding: 26px 0;
	}
	.lower h2,
	.section-heading h2 {
		font:
			24px Georgia,
			serif;
		margin: 8px 0;
	}
	.edge-list {
		display: grid;
		align-content: start;
	}
	.edge {
		display: flex;
		justify-content: space-between;
		gap: 14px;
		text-align: left;
		border: 0;
		border-bottom: 1px solid var(--line, #dce3dd);
		background: none;
		padding: 13px 0;
		cursor: pointer;
		color: inherit;
	}
	.edge span {
		font-size: 12px;
	}
	.edge small {
		color: var(--muted, #66736c);
		font-size: 10px;
	}
	.evidence {
		position: relative;
		background: var(--surface-muted, #f4f6f1);
		padding: 20px;
		min-height: 220px;
	}
	.evidence h2 {
		font:
			24px Georgia,
			serif;
	}
	.evidence p {
		font-size: 12px;
		line-height: 1.6;
	}
	.evidence a {
		font-size: 11px;
		color: #315d48;
	}
	.evidence dl {
		display: grid;
		grid-template-columns: 1fr 1fr;
		font-size: 10px;
		gap: 8px;
	}
	.evidence dt {
		color: var(--muted, #66736c);
	}
	.evidence dd {
		margin: 0;
	}
	.fine {
		border-top: 1px solid var(--line, #dce3dd);
		padding-top: 12px;
		color: #925c48;
	}
	.evidence-prompt {
		padding-top: 50px;
		text-align: center;
	}
	.close {
		position: absolute;
		right: 18px;
		top: 15px;
	}
	.introductions {
		padding-top: 28px;
	}
	.section-heading {
		display: flex;
		justify-content: space-between;
		align-items: end;
	}
	.section-heading small {
		font-size: 10px;
		color: var(--muted, #66736c);
	}
	.intro {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 30px;
		padding: 18px 0;
		border-bottom: 1px solid var(--line, #dce3dd);
	}
	.intro h3 {
		font:
			20px Georgia,
			serif;
		margin: 7px 0;
	}
	.intro p {
		font-size: 11px;
		color: var(--muted, #66736c);
	}
	.next-step {
		display: grid;
		gap: 10px;
	}
	.next-step > p {
		margin: 0;
	}
	.next-step > label {
		display: block;
	}
	.consent-input {
		display: grid;
		grid-template-columns: 1fr 1.5fr;
		gap: 14px;
	}
	.message {
		color: #35634b;
		font-size: 12px;
	}
	.error {
		color: #9d3d36;
	}
	.empty {
		font-size: 12px;
		color: var(--muted, #66736c);
		padding: 20px 0;
	}
	@media (max-width: 760px) {
		.path-search {
			flex-wrap: wrap;
		}
		.path-search label {
			min-width: 40%;
		}
		.path-search button {
			width: 100%;
		}
		.lower {
			grid-template-columns: 1fr;
			gap: 18px;
		}
		.intro {
			grid-template-columns: 1fr;
			gap: 12px;
		}
		.section-heading {
			align-items: start;
			gap: 12px;
			flex-direction: column;
		}
	}

	.graph {
		padding: 26px 0;
		border-bottom: 1px solid var(--line, #dce3dd);
	}
	.graph-head,
	.graph-controls {
		display: flex;
		align-items: end;
		justify-content: space-between;
		gap: 14px;
	}
	.graph-controls button {
		border: 1px solid var(--line, #dce3dd);
		background: white;
		padding: 8px 12px;
		cursor: pointer;
	}
	.graph-canvas {
		width: 100%;
		height: auto;
		min-height: 240px;
		background: var(--surface-muted, #f4f6f1);
		touch-action: none;
		cursor: grab;
	}
	.graph-canvas:active {
		cursor: grabbing;
	}
	.graph-canvas line {
		stroke: #8aa293;
		stroke-width: 2;
	}
	.graph-canvas line.uncertain {
		stroke: #aa684e;
		stroke-dasharray: 5 5;
	}
	.graph-canvas text {
		font: 10px sans-serif;
		fill: #52645a;
		pointer-events: none;
	}
	.graph-node {
		cursor: pointer;
	}
	.graph-node circle {
		fill: #fff;
		stroke: #315d48;
		stroke-width: 2;
	}
	.graph-node:focus circle {
		stroke: #df7055;
		stroke-width: 4;
	}
	.graph-node text {
		font-size: 9px;
	}
	.accessible-graph {
		margin-top: 10px;
		font-size: 12px;
	}
	.accessible-graph summary,
	.evidence details summary {
		cursor: pointer;
		padding: 8px 0;
	}
	.accessible-graph table {
		border-collapse: collapse;
		width: 100%;
		text-align: left;
	}
	.accessible-graph th,
	.accessible-graph td {
		padding: 8px;
		border-bottom: 1px solid var(--line, #dce3dd);
	}
	.lifecycle-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 14px;
		margin: 14px 0;
	}
	.evidence details {
		border-top: 1px solid var(--line, #dce3dd);
		margin-top: 12px;
	}
	.correction-form {
		display: grid;
		gap: 10px;
		padding: 8px 0;
	}
	.history-event {
		border-bottom: 1px solid var(--line, #dce3dd);
		padding: 8px 0;
	}
	@media (max-width: 760px) {
		.graph-head,
		.graph-controls {
			align-items: stretch;
			flex-direction: column;
		}
		.graph-controls label {
			min-width: 100%;
		}
	}
</style>
