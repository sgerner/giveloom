<script lang="ts">
	import { onMount } from 'svelte';
	import ContactPicker from './ContactPicker.svelte';
	export let tenant = '';
	export let contactId = '';
	let tasks: any[] = [];
	let plans: any[] = [];
	let proposals: any[] = [];
	let notifications: any[] = [];
	let assignees: Array<{ id: string; name: string; role: string }> = [];
	let title = '';
	let dueAt = '';
	let priority = 'normal';
	let assignedTo = '';
	let recurring = '';
	let planTitle = '';
	let planStepTitle = '';
	let planStepKind = 'call';
	let planStepDue = '';
	let proposalTitle = '';
	let ask = '';
	let error = '';
	let notice = '';
	let busy = false;
	async function request(url: string, options?: RequestInit) {
		const response = await fetch(url, options);
		const data = await response.json();
		if (!response.ok) throw new Error(data.error || 'Request failed.');
		return data;
	}
	async function load() {
		error = '';
		try {
			const query = contactId ? `?contactId=${encodeURIComponent(contactId)}` : '';
			const [t, p, g, n, a] = await Promise.all([
				request(`/api/v1/tasks${query}`),
				request(`/api/v1/stewardship${query}`),
				request(`/api/v1/proposals${query}`),
				request('/api/v1/notifications'),
				request('/api/v1/tasks/assignees')
			]);
			tasks = t.tasks ?? [];
			plans = p.plans ?? [];
			proposals = g.proposals ?? [];
			notifications = n.notifications ?? [];
			assignees = a.assignees ?? [];
		} catch (e) {
			error = e instanceof Error ? e.message : 'Unable to load stewardship data.';
		}
	}
	async function addTask() {
		busy = true;
		error = '';
		notice = '';
		try {
			const recurrence = recurring ? { frequency: recurring, interval: 1 } : {};
			await request('/api/v1/tasks', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					tenant,
					title,
					contactId: contactId || null,
					dueAt: dueAt ? new Date(dueAt).toISOString() : null,
					priority,
					assignedTo: assignedTo || undefined,
					recurrence
				})
			});
			title = '';
			dueAt = '';
			notice = 'Task saved. A due-time reminder will appear in the internal inbox.';
			await load();
		} catch (e) {
			error = e instanceof Error ? e.message : 'Task save failed.';
		} finally {
			busy = false;
		}
	}
	async function changeStatus(task: any, status: string) {
		try {
			await request(`/api/v1/tasks/${task.id}`, {
				method: 'PATCH',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ status })
			});
			await load();
		} catch (e) {
			error = e instanceof Error ? e.message : 'Task update failed.';
		}
	}
	async function addPlan() {
		if (!contactId) {
			error = 'Choose a contact before adding a stewardship plan.';
			return;
		}
		busy = true;
		try {
			const steps = planStepTitle
				? [
						{
							kind: planStepKind,
							title: planStepTitle,
							dueAt: planStepDue ? new Date(planStepDue).toISOString() : null
						}
					]
				: [];
			await request('/api/v1/stewardship', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ tenant, contactId, title: planTitle, steps })
			});
			planTitle = '';
			planStepTitle = '';
			planStepDue = '';
			notice = 'Stewardship plan saved.';
			await load();
		} catch (e) {
			error = e instanceof Error ? e.message : 'Plan save failed.';
		} finally {
			busy = false;
		}
	}
	async function addProposal() {
		if (!contactId) {
			error = 'Choose a contact before adding a proposal.';
			return;
		}
		busy = true;
		try {
			await request('/api/v1/proposals', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					tenant,
					contactId,
					title: proposalTitle,
					askMinor: Math.round(Number(ask) * 100),
					currency: 'USD'
				})
			});
			proposalTitle = '';
			ask = '';
			notice = 'Proposal saved.';
			await load();
		} catch (e) {
			error = e instanceof Error ? e.message : 'Proposal save failed.';
		} finally {
			busy = false;
		}
	}
	async function updateProposal(proposal: any) {
		try {
			await request('/api/v1/proposals', {
				method: 'PATCH',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					id: proposal.id,
					contactId: proposal.contactId,
					title: proposal.title,
					stage: proposal.stage,
					askMinor: Number(proposal.askMinor),
					currency: proposal.currency,
					expectedCloseAt: proposal.expectedCloseAt
						? String(proposal.expectedCloseAt).slice(0, 10)
						: null,
					notes: proposal.notes ?? '',
					ownerId: proposal.ownerId
				})
			});
			notice = 'Proposal stage updated.';
		} catch (e) {
			error = e instanceof Error ? e.message : 'Proposal update failed.';
			await load();
		}
	}
	async function readNotification(id: string) {
		try {
			await request(`/api/v1/notifications/${id}`, { method: 'PATCH' });
			await load();
		} catch (e) {
			error = e instanceof Error ? e.message : 'Notification update failed.';
		}
	}
	onMount(() => {
		void load();
	});
</script>

<section class="stewardship" aria-labelledby="stewardship-title">
	<header>
		<div>
			<p class="eyebrow">Donor care</p>
			<h2 id="stewardship-title">Tasks and stewardship</h2>
			<p>Track follow-up, plans, proposals, and private internal reminders.</p>
		</div>
		<a href="/api/v1/tasks/calendar.ics">Download task calendar</a>
	</header>
	{#if error}<p role="alert" class="error">{error}</p>{/if}{#if notice}<p
			role="status"
			class="notice"
		>
			{notice}
		</p>{/if}
	<div class="grid">
		<section class="panel">
			<h3>New task</h3>
			<form on:submit|preventDefault={addTask}>
				<label>Task title<input bind:value={title} maxlength="180" required /></label><ContactPicker
					{tenant}
					bind:contactId
					label="Contact (optional)"
				/>
				><label
					>Assignee<select bind:value={assignedTo}
						><option value="">Assign to me</option>{#each assignees as member}<option
								value={member.id}>{member.name} · {member.role}</option
							>{/each}</select
					></label
				><label>Due date and time<input type="datetime-local" bind:value={dueAt} /></label><label
					>Priority<select bind:value={priority}
						><option value="low">Low</option><option value="normal">Normal</option><option
							value="high">High</option
						><option value="urgent">Urgent</option></select
					></label
				><label
					>Repeat<select bind:value={recurring}
						><option value="">No repeat</option><option value="daily">Daily</option><option
							value="weekly">Weekly</option
						><option value="monthly">Monthly</option></select
					></label
				><button disabled={busy || !title.trim()}>Save task</button>
			</form>
		</section>
		<section class="panel">
			<h3>Task list</h3>
			{#if tasks.length}<ul class="items">
					{#each tasks as task}<li>
							<div>
								<strong>{task.title}</strong>
								<p>
									{task.contactName || 'No contact'} · {task.dueAt
										? new Date(task.dueAt).toLocaleString()
										: 'No due date'} · {task.priority} · {task.status}
								</p>
							</div>
							{#if task.status !== 'completed' && task.status !== 'cancelled'}<button
									on:click={() => changeStatus(task, 'completed')}>Complete</button
								>{/if}
						</li>{/each}
				</ul>{:else}<p class="muted">No tasks match this view.</p>{/if}
		</section>
		<section class="panel">
			<h3>Stewardship plan</h3>
			<form on:submit|preventDefault={addPlan}>
				<ContactPicker {tenant} bind:contactId label="Contact" />
				><label>Plan title<input bind:value={planTitle} maxlength="180" required /></label><label
					>First step<input
						bind:value={planStepTitle}
						maxlength="180"
						placeholder="Schedule a call"
					/></label
				><label
					>Step type<select bind:value={planStepKind}
						><option value="call">Call</option><option value="meeting">Meeting</option><option
							value="email_draft">Email draft</option
						><option value="proposal">Proposal</option><option value="research">Research</option
						><option value="note">Note</option></select
					></label
				><label>Step due<input type="datetime-local" bind:value={planStepDue} /></label><button
					disabled={busy || !planTitle.trim()}>Create plan</button
				>
			</form>
			{#each plans as plan}<article class="item">
					<strong>{plan.title}</strong>
					<p>
						{plan.contactName} · {plan.status}{#if plan.reviewAt}
							· Review {new Date(plan.reviewAt).toLocaleDateString()}{/if}
					</p>
					<ul>
						{#each plan.steps as step}<li>{step.kind}: {step.title} · {step.status}</li>{/each}
					</ul>
				</article>{/each}
		</section>
		<section class="panel">
			<h3>Major-gift proposal</h3>
			<form on:submit|preventDefault={addProposal}>
				<ContactPicker {tenant} bind:contactId label="Contact" />
				><label>Proposal title<input bind:value={proposalTitle} maxlength="180" required /></label
				><label
					>Ask amount (USD)<input
						bind:value={ask}
						type="number"
						min="0"
						step="0.01"
						required
					/></label
				><button disabled={busy || !proposalTitle.trim()}>Save proposal</button>
			</form>
			{#each proposals as proposal}<article class="item">
					<div>
						<strong>{proposal.title}</strong>
						<p>
							{proposal.contactName} · {(proposal.askMinor / 100).toLocaleString(undefined, {
								style: 'currency',
								currency: proposal.currency
							})}
						</p>
					</div>
					<label
						>Stage<select bind:value={proposal.stage} on:change={() => updateProposal(proposal)}
							><option value="discovery">Discovery</option><option value="drafting">Drafting</option
							><option value="submitted">Submitted</option><option value="negotiation"
								>Negotiation</option
							><option value="won">Won</option><option value="lost">Lost</option></select
						></label
					>
				</article>{/each}
		</section>
		<section class="panel inbox">
			<h3>Internal reminders</h3>
			{#if notifications.length}<ul class="items">
					{#each notifications as item}<li class:unread={!item.readAt}>
							<div>
								<strong>{item.title}</strong>
								<p>{item.body} · {new Date(item.createdAt).toLocaleString()}</p>
							</div>
							{#if !item.readAt}<button on:click={() => readNotification(item.id)}>Mark read</button
								>{/if}
						</li>{/each}
				</ul>{:else}<p class="muted">No internal reminders.</p>{/if}
		</section>
	</div>
</section>

<style>
	.stewardship {
		color: var(--text, #192b29);
		background: var(--surface, #fff);
		border: 1px solid var(--border, #dbe5e1);
		border-radius: 16px;
		padding: 1.25rem;
	}
	header {
		display: flex;
		justify-content: space-between;
		align-items: flex-start;
		gap: 1rem;
	}
	h2 {
		margin: 0.2rem 0;
	}
	.eyebrow {
		font-size: 0.75rem;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: #4a7568;
		margin: 0;
	}
	.stewardship p {
		color: #657873;
	}
	.grid {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 0.8rem;
	}
	.panel {
		border: 1px solid #e1eae6;
		border-radius: 12px;
		padding: 1rem;
	}
	.panel h3 {
		margin: 0.1rem 0 0.7rem;
	}
	form {
		display: grid;
		gap: 0.55rem;
	}
	label {
		display: grid;
		gap: 0.25rem;
		font-weight: 600;
	}
	input,
	select {
		font: inherit;
		padding: 0.55rem;
		border: 1px solid #cddbd5;
		border-radius: 8px;
	}
	button {
		font: inherit;
		cursor: pointer;
		border: 1px solid #aac0b8;
		border-radius: 8px;
		background: #f4f8f6;
		color: #163d33;
		padding: 0.5rem 0.7rem;
	}
	button:disabled {
		opacity: 0.5;
	}
	.items {
		list-style: none;
		padding: 0;
		margin: 0;
		display: grid;
		gap: 0.5rem;
	}
	.items > li,
	.item {
		border-bottom: 1px solid #e4ece8;
		padding: 0.55rem 0;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.7rem;
	}
	.items p,
	.item p {
		font-size: 0.85rem;
		margin: 0.2rem 0;
	}
	.unread {
		background: #f2f8f4;
	}
	.muted {
		color: #657873;
	}
	.notice {
		background: #f2f8f4;
		padding: 0.6rem;
		border-radius: 8px;
	}
	.error {
		color: #8b281e;
	}
	.inbox {
		grid-column: 1/-1;
	}
	a {
		color: #286556;
	}
	@media (max-width: 720px) {
		.grid {
			grid-template-columns: 1fr;
		}
		header {
			flex-wrap: wrap;
		}
		.inbox {
			grid-column: auto;
		}
	}
</style>
