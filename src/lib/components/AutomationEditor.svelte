<script lang="ts">
	import { onMount } from 'svelte';
	import ContactPicker from './ContactPicker.svelte';
	export let tenant = '';
	let automations: Array<any> = [];
	let selectedId = '';
	let name = 'New stewardship workflow';
	let trigger = 'gift.recorded';
	let triggerSettings: any = { type: 'gift.recorded' };
	let definitionText = JSON.stringify(
		{
			trigger: { type: 'gift.recorded' },
			startId: 'followup',
			nodes: [
				{
					id: 'followup',
					type: 'action',
					action: 'create_task',
					title: 'Thank donor',
					dueInHours: 24,
					next: 'done'
				},
				{ id: 'done', type: 'exit' }
			],
			frequencyCapHours: 24
		},
		null,
		2
	);
	let contactId = '';
	let notice = '';
	let busy = false;
	let simulation: any = null;
	let visualNodes: Array<any> = [];
	let selectedNodeId = '';
	let nodeDraft: any = {};
	let addNodeType = 'action';
	let approvals: Array<any> = [];
	async function refresh() {
		const response = await fetch('/api/v1/automations');
		const data = await response.json();
		if (!response.ok) throw new Error(data.error || 'Unable to load workflows.');
		automations = data.automations ?? [];
		if (selectedId) {
			const selected = automations.find((item) => item.id === selectedId);
			if (selected) {
				name = selected.name;
				definitionText = JSON.stringify(selected.draft, null, 2);
				trigger = selected.draft?.trigger?.type ?? trigger;
				triggerSettings = { ...(selected.draft?.trigger || {}), type: trigger };
				syncVisualFromDefinition();
			}
		}
	}
	async function loadApprovals() {
		try {
			const response = await fetch('/api/v1/automation-approvals');
			const data = await response.json();
			if (response.ok) approvals = data.approvals ?? [];
		} catch {
			/* Approval inbox stays optional if the service is unavailable. */
		}
	}
	function syncVisualFromDefinition() {
		try {
			const value = JSON.parse(definitionText);
			visualNodes = Array.isArray(value.nodes) ? value.nodes : [];
			if (!visualNodes.some((node) => node.id === selectedNodeId))
				selectedNodeId = visualNodes[0]?.id ?? '';
			const chosen = visualNodes.find((node) => node.id === selectedNodeId);
			nodeDraft = chosen ? { ...chosen } : {};
		} catch {
			visualNodes = [];
			selectedNodeId = '';
			nodeDraft = {};
		}
	}
	function syncDefinitionFromVisual() {
		try {
			const value = JSON.parse(definitionText);
			value.nodes = visualNodes;
			definitionText = JSON.stringify(value, null, 2);
		} catch {
			/* Keep the advanced editor error visible until valid JSON is restored. */
		}
	}
	function chooseVisualNode(node: any) {
		selectedNodeId = node.id;
		nodeDraft = { ...node };
	}
	function updateVisualNode() {
		if (nodeDraft.dueInHours !== undefined) nodeDraft.dueInHours = Number(nodeDraft.dueInHours);
		if (nodeDraft.minutes !== undefined) nodeDraft.minutes = Number(nodeDraft.minutes);
		visualNodes = visualNodes.map((node) =>
			node.id === selectedNodeId ? { ...node, ...nodeDraft } : node
		);
		syncDefinitionFromVisual();
	}
	function changeTrigger() {
		const defaults: any = {
			schedule: { intervalMinutes: 1440 },
			'contact.tagged': { tag: '' },
			'segment.entry': { segmentId: '' },
			'segment.exit': { segmentId: '' },
			'pledge.overdue': { daysOverdue: 1 },
			'form.submitted': { formId: '' },
			'email.engagement': { engagement: 'opened' },
			inactivity: { days: 180 },
			'prospect.score_threshold': { threshold: 75 },
			birthday: { fieldId: '', requireConsent: true }
		};
		triggerSettings = { type: trigger, ...(defaults[trigger] || {}) };
		applyTriggerSettings();
	}
	function applyTriggerSettings() {
		try {
			const value = JSON.parse(definitionText);
			const settings = { ...triggerSettings };
			for (const key of ['intervalMinutes', 'daysOverdue', 'days', 'threshold'])
				if (settings[key] !== undefined) settings[key] = Number(settings[key]);
			value.trigger = { ...settings, type: trigger };
			triggerSettings = value.trigger;
			definitionText = JSON.stringify(value, null, 2);
		} catch {
			notice = 'Fix the workflow definition before changing trigger settings.';
		}
	}
	function parseNodeValue(event: Event, key: 'value') {
		const raw = (event.currentTarget as HTMLInputElement).value;
		try {
			nodeDraft[key] = JSON.parse(raw);
		} catch {
			nodeDraft[key] = raw;
		}
		updateVisualNode();
	}
	function addVisualNode() {
		let base: any;
		try {
			base = JSON.parse(definitionText);
		} catch {
			notice = 'Fix the JSON definition before using visual editing.';
			return;
		}
		let nodes = Array.isArray(base.nodes) ? [...base.nodes] : [];
		let terminal = [...nodes].reverse().find((node: any) => node.type === 'exit');
		if (!terminal) {
			terminal = { id: `exit-${Date.now()}`, type: 'exit' };
			nodes.push(terminal);
		}
		const id = `node-${Date.now()}`,
			exitId = `exit-${Date.now() + 1}`;
		if (addNodeType === 'condition') {
			Object.assign(terminal, {
				type: 'condition',
				field: 'contact.consent',
				operator: 'equals',
				value: true,
				whenTrue: exitId,
				whenFalse: exitId
			});
			nodes.push({ id: exitId, type: 'exit' });
		} else if (addNodeType === 'wait') {
			Object.assign(terminal, { type: 'wait', minutes: 5, next: exitId });
			nodes.push({ id: exitId, type: 'exit' });
		} else {
			Object.assign(terminal, {
				type: 'action',
				action: 'create_task',
				title: 'Stewardship follow-up',
				dueInHours: 24,
				next: exitId
			});
			nodes.push({ id: exitId, type: 'exit' });
		}
		visualNodes = nodes;
		base.nodes = nodes;
		definitionText = JSON.stringify(base, null, 2);
		chooseVisualNode(terminal);
	}
	function currentStartId() {
		try {
			return JSON.parse(definitionText).startId || '';
		} catch {
			return '';
		}
	}
	function setStartNode(id: string) {
		try {
			const value = JSON.parse(definitionText);
			value.startId = id;
			definitionText = JSON.stringify(value, null, 2);
		} catch {
			notice = 'Fix the workflow definition before changing its start node.';
		}
	}
	function removeVisualNode() {
		let start = '';
		try {
			start = JSON.parse(definitionText).startId;
		} catch {
			notice = 'Fix the workflow definition before removing a node.';
			return;
		}
		if (!selectedNodeId || selectedNodeId === start) {
			notice = 'The start node cannot be removed.';
			return;
		}
		const incoming = visualNodes.some((node) =>
			node.type === 'condition'
				? [node.whenTrue, node.whenFalse].includes(selectedNodeId)
				: node.type !== 'exit' && node.next === selectedNodeId
		);
		if (incoming) {
			notice = 'Reconnect incoming steps before removing this node.';
			return;
		}
		visualNodes = visualNodes.filter((node) => node.id !== selectedNodeId);
		selectedNodeId = visualNodes[0]?.id ?? '';
		nodeDraft = selectedNodeId ? { ...visualNodes[0] } : {};
		syncDefinitionFromVisual();
	}
	async function selectWorkflow(id: string) {
		selectedId = id;
		simulation = null;
		const item = automations.find((value) => value.id === id);
		if (item) {
			name = item.name;
			definitionText = JSON.stringify(item.draft, null, 2);
			trigger = item.draft?.trigger?.type ?? trigger;
			triggerSettings = { ...(item.draft?.trigger || {}), type: trigger };
			syncVisualFromDefinition();
		}
	}
	function parsed() {
		const value = JSON.parse(definitionText);
		value.trigger = { ...triggerSettings, type: trigger };
		return value;
	}
	async function save() {
		busy = true;
		notice = '';
		try {
			const draft = parsed();
			const response = selectedId
				? await fetch(`/api/v1/automations/${selectedId}`, {
						method: 'PATCH',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({ name, definition: draft })
					})
				: await fetch('/api/v1/automations', {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({ tenant, name, definition: draft })
					});
			const data = await response.json();
			if (!response.ok) throw new Error(data.error || 'Unable to save workflow.');
			selectedId = data.automation.id;
			await refresh();
			notice = 'Draft saved as a new immutable version.';
		} catch (error) {
			notice = error instanceof Error ? error.message : 'Unable to save workflow.';
		} finally {
			busy = false;
		}
	}
	async function action(path: string, body?: unknown) {
		if (!selectedId) return;
		busy = true;
		notice = '';
		try {
			const response = await fetch(`/api/v1/automations/${selectedId}/${path}`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				...(body ? { body: JSON.stringify(body) } : {})
			});
			const data = await response.json();
			if (!response.ok) throw new Error(data.error || 'Workflow action failed.');
			notice =
				path === 'validate'
					? data.valid
						? 'Workflow definition is valid.'
						: data.issues.map((x: any) => x.message).join(' ')
					: path === 'simulate'
						? `Simulation completed (${data.steps.length} steps); no records changed.`
						: path === 'run'
							? `Run ${data.status}.`
							: path === 'publish'
								? 'Published version is active.'
								: 'Workflow paused.';
			if (path === 'simulate') simulation = data;
			await refresh();
		} catch (error) {
			notice = error instanceof Error ? error.message : 'Workflow action failed.';
		} finally {
			busy = false;
		}
	}
	async function decideApproval(id: string, approved: boolean) {
		try {
			const response = await fetch(`/api/v1/automation-approvals/${id}`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ approved })
			});
			const data = await response.json();
			if (!response.ok) throw new Error(data.error || 'Approval update failed.');
			notice = approved
				? 'Reviewed draft created. It remains unsent until a separate email review and send approval.'
				: 'Draft request rejected.';
			await loadApprovals();
		} catch (error) {
			notice = error instanceof Error ? error.message : 'Approval update failed.';
		}
	}
	async function generateApprovalDraft(id: string) {
		busy = true;
		try {
			const response = await fetch(`/api/v1/automation-approvals/${id}/generate`, {
				method: 'POST'
			});
			const data = await response.json();
			if (!response.ok) throw new Error(data.error || 'AI draft generation failed.');
			notice = 'AI draft generated. Review the message before approving the unsent email draft.';
			await loadApprovals();
		} catch (error) {
			notice = error instanceof Error ? error.message : 'AI draft generation failed.';
		} finally {
			busy = false;
		}
	}
	onMount(() => {
		syncVisualFromDefinition();
		refresh().catch((error) => (notice = error.message));
		void loadApprovals();
	});
</script>

<section class="automation-editor" aria-labelledby="automation-title">
	<header>
		<div>
			<p class="eyebrow">Workflow studio</p>
			<h2 id="automation-title">Automations</h2>
			<p>Version drafts, validate the path, then publish. Simulations have no side effects.</p>
		</div>
		<button
			type="button"
			on:click={() => {
				selectedId = '';
				name = 'New stewardship workflow';
				trigger = 'gift.recorded';
				triggerSettings = { type: 'gift.recorded' };
				simulation = null;
			}}>New workflow</button
		>
	</header>
	<div class="layout">
		<aside>
			<h3>Saved workflows</h3>
			{#if automations.length}<ul>
					{#each automations as item}<li>
							<button
								class:active={selectedId === item.id}
								type="button"
								on:click={() => selectWorkflow(item.id)}
								><strong>{item.name}</strong><span
									>{item.status} · v{item.currentVersion}{item.publishedVersion
										? ` · live v${item.publishedVersion}`
										: ''}</span
								></button
							>
						</li>{/each}
				</ul>{:else}<p class="muted">No workflows yet.</p>{/if}
		</aside>
		<div class="editor">
			<label>Workflow name<input bind:value={name} maxlength="180" /></label><label
				>Trigger<select bind:value={trigger} on:change={changeTrigger}
					><option value="gift.recorded">Gift recorded</option><option value="first_gift"
						>First gift</option
					><option value="recurring_gift_failed">Recurring gift failed</option><option
						value="donation_anniversary">Donation anniversary</option
					><option value="birthday">Birthday (consented contact date field)</option><option
						value="contact.created">Contact created</option
					><option value="contact.tagged">Contact tagged</option><option value="segment.entry"
						>Segment entry</option
					><option value="segment.exit">Segment exit</option><option value="pledge.overdue"
						>Pledge overdue</option
					><option value="form.submitted">Form submitted</option><option value="email.engagement"
						>Email engagement</option
					><option value="inactivity">Donor inactivity</option><option
						value="prospect.score_threshold">Prospect score threshold</option
					><option value="task.completed">Task completed</option><option value="manual"
						>Manual</option
					><option value="schedule">Scheduled</option></select
				><small
					>Some event triggers require their connected provider or domain event to be enabled.
					Birthday rules require an explicit consented date field.</small
				></label
			>
			{#if trigger === 'schedule'}<label
					>Interval in minutes<input
						type="number"
						min="15"
						max="525600"
						bind:value={triggerSettings.intervalMinutes}
						on:input={applyTriggerSettings}
					/></label
				>{/if}
			{#if trigger === 'contact.tagged'}<label
					>Tag<input bind:value={triggerSettings.tag} on:input={applyTriggerSettings} /></label
				>{/if}
			{#if trigger === 'segment.entry' || trigger === 'segment.exit'}<label
					>Segment ID<input
						bind:value={triggerSettings.segmentId}
						on:input={applyTriggerSettings}
					/></label
				>{/if}
			{#if trigger === 'pledge.overdue'}<label
					>Days overdue<input
						type="number"
						min="0"
						max="365"
						bind:value={triggerSettings.daysOverdue}
						on:input={applyTriggerSettings}
					/></label
				>{/if}
			{#if trigger === 'form.submitted'}<label
					>Form ID<input
						bind:value={triggerSettings.formId}
						on:input={applyTriggerSettings}
					/></label
				>{/if}
			{#if trigger === 'email.engagement'}<label
					>Engagement<select
						bind:value={triggerSettings.engagement}
						on:change={applyTriggerSettings}
						><option value="delivered">Delivered</option><option value="opened">Opened</option
						><option value="clicked">Clicked</option></select
					></label
				>{/if}
			{#if trigger === 'inactivity'}<label
					>Inactive days<input
						type="number"
						min="1"
						max="3650"
						bind:value={triggerSettings.days}
						on:input={applyTriggerSettings}
					/></label
				>{/if}
			{#if trigger === 'prospect.score_threshold'}<label
					>Score threshold<input
						type="number"
						min="0"
						max="100"
						bind:value={triggerSettings.threshold}
						on:input={applyTriggerSettings}
					/></label
				>{/if}
			{#if trigger === 'birthday'}<label
					>Contact date field ID<input
						bind:value={triggerSettings.fieldId}
						on:input={applyTriggerSettings}
					/></label
				>
				<p class="muted">
					Birthday triggers always require current email marketing consent and a non-sensitive date
					field.
				</p>{/if}
			<section class="visual-builder" aria-labelledby="visual-builder-title">
				<header>
					<div>
						<h3 id="visual-builder-title">Visual workflow builder</h3>
						<p>Choose a node to inspect it. Branches and outgoing links are shown by node ID.</p>
					</div>
					<button type="button" on:click={syncVisualFromDefinition}>Load from definition</button>
				</header>
				<div class="node-tools">
					<label
						>Add a step<select bind:value={addNodeType}
							><option value="action">Action</option><option value="condition">Condition</option
							><option value="wait">Wait</option></select
						></label
					><button type="button" on:click={addVisualNode}>Add step</button><label
						>Start node<select
							value={currentStartId()}
							on:change={(event) => setStartNode(event.currentTarget.value)}
							><option value="">Choose start node</option>{#each visualNodes as node}<option
									value={node.id}>{node.id}</option
								>{/each}</select
						></label
					>
				</div>
				<div class="node-layout">
					<ol class="node-list" aria-label="Workflow nodes">
						{#each visualNodes as node, index}<li>
								<button
									type="button"
									class:active={selectedNodeId === node.id}
									aria-pressed={selectedNodeId === node.id}
									on:click={() => chooseVisualNode(node)}
									><span>{index + 1}. {node.type}</span><strong>{node.id}</strong><small
										>{node.type === 'action'
											? node.action
											: node.type === 'condition'
												? `${node.field} ${node.operator}`
												: node.type}</small
									>{#if node.type === 'condition'}<small
											>True → {node.whenTrue} · False → {node.whenFalse}</small
										>{:else if node.next}<small>Next → {node.next}</small>{/if}</button
								>
							</li>{/each}
					</ol>
					{#if selectedNodeId}<section class="inspector" aria-labelledby="node-inspector-title">
							<h4 id="node-inspector-title">Inspect {nodeDraft.type} node</h4>
							<label>Node ID<input value={nodeDraft.id} readonly /></label
							>{#if nodeDraft.type === 'action'}<label
									>Action<select bind:value={nodeDraft.action} on:change={updateVisualNode}
										><option value="create_task">Create task</option><option value="notify"
											>Internal notification</option
										><option value="add_tag">Add tag</option><option value="update_stage"
											>Change stage</option
										><option value="update_field">Update non-sensitive field</option><option
											value="email">Email draft (approval required)</option
										><option value="email_draft">Unsent email draft</option><option value="ai_draft"
											>AI-assisted draft request (approval required)</option
										><option value="webhook">Approved webhook endpoint</option></select
									></label
								><label
									>Title / task name<input
										bind:value={nodeDraft.title}
										on:input={updateVisualNode}
									/></label
								><label
									>Message, email body, or AI prompt<textarea
										rows="3"
										bind:value={nodeDraft.body}
										on:input={updateVisualNode}></textarea></label
								><label
									>Email subject<input
										bind:value={nodeDraft.subject}
										on:input={updateVisualNode}
									/></label
								>{#if nodeDraft.action === 'add_tag'}<label
										>Tag<input bind:value={nodeDraft.tag} on:input={updateVisualNode} /></label
									>{/if}{#if nodeDraft.action === 'update_stage'}<label
										>New stage<select bind:value={nodeDraft.stage} on:change={updateVisualNode}
											>{#each ['new', 'prospect', 'active', 'lapsed', 'major_gift', 'do_not_contact'] as stage}<option
													value={stage}>{stage}</option
												>{/each}</select
										></label
									>{/if}{#if nodeDraft.action === 'update_field'}<label
										>Custom field ID<input
											bind:value={nodeDraft.fieldId}
											on:input={updateVisualNode}
										/></label
									><label
										>JSON value<input
											value={JSON.stringify(nodeDraft.value ?? null)}
											on:input={(event) => parseNodeValue(event, 'value')}
										/></label
									>{/if}{#if nodeDraft.action === 'webhook'}<label
										>Approved endpoint ID<input
											bind:value={nodeDraft.endpointId}
											on:input={updateVisualNode}
										/></label
									><label
										>Event label<input
											bind:value={nodeDraft.eventName}
											on:input={updateVisualNode}
										/></label
									>{/if}<label
									>Due in hours<input
										type="number"
										min="0"
										max="8760"
										bind:value={nodeDraft.dueInHours}
										on:input={updateVisualNode}
									/></label
								>{:else if nodeDraft.type === 'condition'}<label
									>Condition field<select bind:value={nodeDraft.field} on:change={updateVisualNode}
										>{#each ['gift.amountMinor', 'gift.lifetimeGivingMinor', 'gift.kind', 'gift.status', 'contact.stage', 'contact.consent', 'contact.tags', 'contact.segmentIds', 'contact.timeSinceLastGiftDays', 'contact.assignedOfficerId', 'contact.source', 'contact.relationshipConfidence', 'task.status', 'prospect.score'] as field}<option
												value={field}>{field}</option
											>{/each}</select
									></label
								><label
									>Operator<select bind:value={nodeDraft.operator} on:change={updateVisualNode}
										>{#each ['equals', 'not_equals', 'greater_than', 'greater_or_equal', 'less_than', 'less_or_equal', 'contains'] as operator}<option
												value={operator}>{operator.replaceAll('_', ' ')}</option
											>{/each}</select
									></label
								><label
									>Expected value<input
										value={JSON.stringify(nodeDraft.value ?? '')}
										on:input={(event) => parseNodeValue(event, 'value')}
									/></label
								><label
									>When true, go to<input
										bind:value={nodeDraft.whenTrue}
										on:input={updateVisualNode}
									/></label
								><label
									>When false, go to<input
										bind:value={nodeDraft.whenFalse}
										on:input={updateVisualNode}
									/></label
								>{:else if nodeDraft.type === 'wait'}<label
									>Wait minutes<input
										type="number"
										min="1"
										max="525600"
										bind:value={nodeDraft.minutes}
										on:input={updateVisualNode}
									/></label
								>{/if}{#if nodeDraft.type !== 'condition' && nodeDraft.type !== 'exit'}<label
									>Next node<input bind:value={nodeDraft.next} on:input={updateVisualNode} /></label
								>{/if}<button type="button" class="secondary" on:click={removeVisualNode}
								>Remove selected node</button
							>
						</section>{:else}<p class="muted">Choose a node to inspect its settings.</p>{/if}
				</div>
			</section>
			<details>
				<summary>Advanced JSON definition</summary><label
					>Versioned workflow definition<textarea
						bind:value={definitionText}
						rows="17"
						spellcheck="false"></textarea><small
						>Advanced editing preserves the versioned workflow JSON format.</small
					></label
				>
			</details>
			<div class="actions">
				<button type="button" disabled={busy} on:click={save}>Save draft</button><button
					type="button"
					disabled={busy || !selectedId}
					on:click={() => action('validate')}>Validate</button
				><button type="button" disabled={busy || !selectedId} on:click={() => action('publish')}
					>Publish</button
				><button type="button" disabled={busy || !selectedId} on:click={() => action('pause')}
					>Pause</button
				>
			</div>
			<div class="simulation">
				<ContactPicker {tenant} bind:contactId label="Contact for simulation or manual launch" />
				>
				<div class="actions">
					<button
						type="button"
						disabled={busy || !selectedId || !contactId}
						on:click={() => action('simulate', { contactId })}>Simulate draft</button
					><button
						type="button"
						disabled={busy || !selectedId || !contactId || trigger !== 'manual'}
						on:click={() => action('run', { contactId })}>Start manual run</button
					>
				</div>
			</div>
			<section class="approval-inbox" aria-labelledby="approval-inbox-title">
				<h3 id="approval-inbox-title">Workflow draft approvals</h3>
				<p>
					Generated email and AI-assisted requests stay unsent. Approving creates a draft; sending
					still requires a fresh recipient preview and one-use approval.
				</p>
				{#if approvals.length}{#each approvals as approval}<article>
							<div>
								<strong>{approval.automationName}</strong>
								<p>
									{approval.actionType === 'ai_draft' ? 'AI-assisted draft request' : 'Email draft'} for
									{approval.contactName} · expires {new Date(
										approval.expiresAt
									).toLocaleDateString()}
								</p>
								<pre>{approval.content?.aiGenerated
										? approval.content.body
										: approval.content?.body || approval.content?.prompt || ''}</pre>
							</div>
							<div class="actions">
								{#if approval.actionType === 'ai_draft'}<button
										type="button"
										disabled={busy}
										on:click={() => generateApprovalDraft(approval.id)}
										>{approval.content?.aiGenerated
											? 'Regenerate AI draft'
											: 'Generate AI draft'}</button
									>{/if}<button
									type="button"
									disabled={busy}
									on:click={() => decideApproval(approval.id, false)}>Reject</button
								><button
									type="button"
									disabled={busy ||
										(approval.actionType === 'ai_draft' && approval.content?.aiGenerated !== true)}
									on:click={() => decideApproval(approval.id, true)}>Approve draft</button
								>
							</div>
						</article>{/each}{:else}<p class="muted">
						No drafts are waiting for review.
					</p>{/if}<button type="button" class="secondary" on:click={loadApprovals}
					>Refresh approvals</button
				>
			</section>
			{#if notice}<p class="notice" role="status">{notice}</p>{/if}{#if simulation}<ol
					class="preview"
				>
					{#each simulation.steps as step}<li>
							<strong>{step.nodeId}</strong>: {step.outcome}
						</li>{/each}
				</ol>{/if}
		</div>
	</div>
</section>

<style>
	.automation-editor {
		color: var(--text, #192b29);
		background: var(--surface, #fff);
		border: 1px solid var(--border, #dbe5e1);
		border-radius: 16px;
		padding: 1.25rem;
	}
	header {
		display: flex;
		justify-content: space-between;
		gap: 1rem;
		align-items: flex-start;
		margin-bottom: 1rem;
	}
	h2,
	h3,
	p {
		margin-top: 0;
	}
	.eyebrow {
		font-size: 0.75rem;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: #4a7568;
		margin-bottom: 0.35rem;
	}
	header p {
		color: #657873;
		margin-bottom: 0;
	}
	.layout {
		display: grid;
		grid-template-columns: minmax(12rem, 0.75fr) minmax(24rem, 2fr);
		gap: 1rem;
	}
	aside,
	.editor {
		border: 1px solid var(--border, #dbe5e1);
		border-radius: 12px;
		padding: 1rem;
	}
	ul {
		list-style: none;
		padding: 0;
		margin: 0;
		display: grid;
		gap: 0.5rem;
	}
	li button {
		width: 100%;
		display: grid;
		text-align: left;
		gap: 0.25rem;
		border: 1px solid #e2ebe7;
		background: #fff;
		padding: 0.7rem;
		border-radius: 8px;
		color: inherit;
	}
	li button.active {
		border-color: #548579;
		background: #f0f7f4;
	}
	li span,
	small,
	.muted {
		color: #687b76;
		font-size: 0.85rem;
	}
	.editor {
		display: grid;
		gap: 0.8rem;
	}
	label {
		display: grid;
		gap: 0.35rem;
		font-weight: 600;
	}
	input,
	select,
	textarea {
		font: inherit;
		border: 1px solid #cddbd5;
		border-radius: 8px;
		padding: 0.65rem;
		color: inherit;
		background: #fff;
	}
	textarea {
		font-family: ui-monospace, monospace;
		font-size: 0.85rem;
	}
	.actions,
	.node-tools {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		align-items: end;
	}
	button {
		font: inherit;
		cursor: pointer;
		border: 1px solid #aac0b8;
		border-radius: 8px;
		background: #f4f8f6;
		color: #163d33;
		padding: 0.55rem 0.75rem;
	}
	button:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
	.notice {
		padding: 0.65rem;
		background: #f1f7f3;
		border-radius: 8px;
	}
	.preview {
		margin: 0;
		padding-left: 1.5rem;
	}
	.simulation {
		border-top: 1px solid #e4ece8;
		padding-top: 0.8rem;
		display: grid;
		gap: 0.6rem;
	}
	.visual-builder,
	.approval-inbox {
		border: 1px solid var(--border, #dbe5e1);
		border-radius: 12px;
		padding: 1rem;
		display: grid;
		gap: 0.8rem;
	}
	.visual-builder > header {
		margin: 0;
	}
	.visual-builder > header h3,
	.approval-inbox h3 {
		margin: 0;
	}
	.node-layout {
		display: grid;
		grid-template-columns: minmax(12rem, 0.8fr) minmax(15rem, 1.2fr);
		gap: 0.8rem;
		align-items: start;
	}
	.node-list {
		display: grid;
		gap: 0.45rem;
		margin: 0;
		padding-left: 1.5rem;
	}
	.node-list button {
		width: 100%;
		display: grid;
		gap: 0.2rem;
		text-align: left;
		background: var(--surface, #fff);
		color: inherit;
	}
	.node-list button.active {
		border-color: #548579;
		background: #f0f7f4;
	}
	.inspector {
		border: 1px solid var(--border, #dbe5e1);
		border-radius: 10px;
		padding: 0.8rem;
		display: grid;
		gap: 0.6rem;
	}
	.inspector h4 {
		margin: 0;
	}
	.approval-inbox article {
		display: flex;
		justify-content: space-between;
		align-items: flex-start;
		gap: 1rem;
		border-top: 1px solid var(--border, #dbe5e1);
		padding: 0.8rem 0;
	}
	.approval-inbox pre {
		white-space: pre-wrap;
		max-height: 8rem;
		overflow: auto;
		background: #f4f8f6;
		padding: 0.6rem;
	}
	@media (max-width: 760px) {
		.layout,
		.node-layout {
			grid-template-columns: 1fr;
		}
		header {
			flex-wrap: wrap;
		}
		.approval-inbox article {
			flex-direction: column;
		}
	}
</style>
