<script lang="ts">
	import { untrack } from 'svelte';
	let { data } = $props<{
		data: {
			tenants: Array<{
				id: string;
				slug: string;
				legalName: string;
				createdAt: string;
				suspendedAt?: string | null;
				suspensionReason?: string | null;
				planLabel?: string;
				subscriptionStatus?: string;
				activeMembers: number;
				contactCount: number;
				pendingOutbox: number;
			}>;
		};
	}>();
	let error = $state(''),
		notice = $state(''),
		busy = $state(false),
		slug = $state(''),
		legalName = $state(''),
		currency = $state('USD'),
		timezone = $state('UTC'),
		confirmed = $state(false),
		tenants = $state(untrack(() => data.tenants));
	async function command(body: unknown) {
		busy = true;
		error = '';
		notice = '';
		try {
			const r = await fetch('/api/v1/platform/tenants', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body)
			});
			const result = await r.json();
			if (!r.ok) throw new Error(result.error);
			notice = result.result.integrations || result.result.initialOwner || 'Saved and audited.';
			const refresh = await fetch('/api/v1/platform/tenants');
			tenants = (await refresh.json()).tenants;
			confirmed = false;
		} catch (e) {
			error = e instanceof Error ? e.message : 'Platform change failed.';
		} finally {
			busy = false;
		}
	}
	async function status(tenant: any) {
		const reason = window.prompt('Reason for this tenant status change (required)');
		if (
			!reason ||
			!window.confirm(`${tenant.suspendedAt ? 'Resume' : 'Suspend'} ${tenant.legalName}?`)
		)
			return;
		await command({
			action: tenant.suspendedAt ? 'resume' : 'suspend',
			tenantId: tenant.id,
			reason,
			confirmed: true
		});
	}
	async function plan(tenant: any) {
		const planLabel = window.prompt(
			'Plan label (operator maintained; no billing operation)',
			tenant.planLabel || 'Self hosted'
		);
		if (!planLabel) return;
		const subscriptionStatus = window.prompt(
			'Status: self_hosted, trial, active, past_due, canceled',
			tenant.subscriptionStatus || 'self_hosted'
		);
		if (!subscriptionStatus) return;
		const reason = window.prompt('Reason for the plan record change');
		if (!reason || !window.confirm('Update this operator-maintained plan record?')) return;
		await command({
			action: 'plan',
			tenantId: tenant.id,
			planLabel,
			subscriptionStatus,
			reason,
			confirmed: true
		});
	}
</script>

<svelte:head><title>Platform tenants · Donor CRM</title></svelte:head>
<main class="platform">
	<nav>
		<a href="/platform/health">Health</a><a href="/platform/audit">Audit</a><a
			href="/platform/tenants"
			aria-current="page">Tenants</a
		>
	</nav>
	<span class="eyebrow">OPERATOR CONSOLE</span>
	<h1>Tenant overview<span>.</span></h1>
	<p>
		Aggregate workspace health for support and operations. No donor or contact details are included.
	</p>
	{#if error}<p role="alert">{error}</p>{/if}{#if notice}<p role="status">{notice}</p>{/if}
	<details>
		<summary>Create a tenant</summary>
		<form
			class="tenant-create"
			onsubmit={(e) => {
				e.preventDefault();
				command({ action: 'create', slug, legalName, currency, timezone, confirmed: true });
			}}
		>
			<label>Legal name<input required bind:value={legalName} /></label><label
				>Slug<input required pattern="[a-z0-9-]+" bind:value={slug} /></label
			><label>Currency<input required maxlength="3" bind:value={currency} /></label><label
				>IANA time zone<input required bind:value={timezone} /></label
			><label
				><input type="checkbox" required bind:checked={confirmed} /> Create this tenant with my operator
				account as its initial owner</label
			><button disabled={busy || !confirmed}>Create tenant</button>
		</form>
	</details>
	<div class="table-scroll">
		<table>
			<thead
				><tr
					><th>Workspace</th><th>Access</th><th>Plan record</th><th>Created</th><th>Active staff</th
					><th>Contacts</th><th>Pending jobs</th></tr
				></thead
			><tbody
				>{#each tenants as tenant (tenant.id)}<tr
						><td><strong>{tenant.legalName}</strong><small>{tenant.slug}</small></td><td
							><button disabled={busy} onclick={() => status(tenant)}
								>{tenant.suspendedAt ? 'Resume suspended tenant' : 'Suspend tenant'}</button
							></td
						><td
							>{tenant.planLabel || 'Self hosted'} · {tenant.subscriptionStatus ||
								'self_hosted'}<button disabled={busy} onclick={() => plan(tenant)}
								>Edit plan record</button
							></td
						><td>{new Date(tenant.createdAt).toLocaleDateString()}</td><td
							>{tenant.activeMembers}</td
						><td>{tenant.contactCount}</td><td>{tenant.pendingOutbox}</td></tr
					>{:else}<tr><td colspan="7">No workspaces yet.</td></tr>{/each}</tbody
			>
		</table>
	</div>
</main>

<style>
	.tenant-create {
		display: grid;
		gap: 0.8rem;
		max-width: 36rem;
		margin: 1rem 0;
	}
	.tenant-create label {
		display: grid;
		gap: 0.3rem;
	}
	.tenant-create input {
		padding: 0.6rem;
		border: 1px solid var(--line);
		background: var(--white);
		color: var(--ink);
	}

	.platform {
		max-width: 1100px;
		margin: 0 auto;
		padding: clamp(24px, 6vw, 64px);
		color: var(--ink, #17211c);
	}
	nav {
		display: flex;
		gap: 20px;
		margin-bottom: 42px;
		border-bottom: 1px solid var(--line, #ccd4ce);
		padding-bottom: 13px;
	}
	nav a {
		color: inherit;
	}
	nav a[aria-current] {
		font-weight: 700;
	}
	.eyebrow {
		font-size: 11px;
		letter-spacing: 0.14em;
	}
	.platform h1 {
		font-size: clamp(32px, 5vw, 54px);
		margin: 8px 0;
	}
	.platform h1 span {
		color: var(--accent, #6d8e78);
	}
	.platform > p {
		color: var(--muted, #59665d);
	}
	.table-scroll {
		overflow-x: auto;
		margin-top: 24px;
	}
	table {
		border-collapse: collapse;
		width: 100%;
		min-width: 680px;
	}
	th,
	td {
		text-align: left;
		padding: 12px;
		border-bottom: 1px solid var(--line, #ccd4ce);
	}
	td small {
		display: block;
		color: var(--muted, #59665d);
		margin-top: 4px;
	}
</style>
