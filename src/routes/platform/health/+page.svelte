<script lang="ts">
	let { data } = $props<{
		data: {
			tenantCount: number;
			health: {
				databaseConnections: number;
				pendingOutbox: number;
				failedOutbox: number;
				failedWebhooks: number;
			};
			tenants: Array<{
				id: string;
				slug: string;
				pendingOutbox: number;
				failedOutbox: number;
				failedWebhooks: number;
			}>;
			snapshotAt: string;
		};
	}>();
</script>

<svelte:head><title>Platform health · GiveLoom</title></svelte:head>
<main class="platform">
	<nav>
		<a href="/platform/health" aria-current="page">Health</a><a href="/platform/tenants">Tenants</a>
	</nav>
	<span class="eyebrow">OPERATOR CONSOLE</span>
	<h1>Platform health<span>.</span></h1>
	<p>Tenant-level operational counts only. Donor records and contact details are not displayed.</p>
	<div class="metrics">
		<article><small>Tenants</small><strong>{data.tenantCount}</strong></article>
		<article>
			<small>Database connections</small><strong>{data.health.databaseConnections}</strong>
		</article>
		<article><small>Pending outbox</small><strong>{data.health.pendingOutbox}</strong></article>
		<article><small>Failed outbox</small><strong>{data.health.failedOutbox}</strong></article>
		<article><small>Failed webhooks</small><strong>{data.health.failedWebhooks}</strong></article>
	</div>
	<h2>Tenant operations</h2>
	<table>
		<thead
			><tr><th>Workspace</th><th>Pending</th><th>Outbox failures</th><th>Webhook failures</th></tr
			></thead
		><tbody
			>{#each data.tenants as tenant (tenant.id)}<tr
					><td>{tenant.slug}</td><td>{tenant.pendingOutbox}</td><td>{tenant.failedOutbox}</td><td
						>{tenant.failedWebhooks}</td
					></tr
				>{:else}<tr><td colspan="4">No tenants yet.</td></tr>{/each}</tbody
		>
	</table>
	<small class="muted">Snapshot {new Date(data.snapshotAt).toLocaleString()}</small>
</main>

<style>
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
	.platform > p,
	.muted {
		color: var(--muted, #59665d);
	}
	.metrics {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
		gap: 18px;
		margin: 32px 0 48px;
	}
	.metrics article {
		border-top: 2px solid var(--accent, #6d8e78);
		padding-top: 12px;
	}
	.metrics small,
	.metrics strong {
		display: block;
	}
	.metrics small {
		color: var(--muted, #59665d);
	}
	.metrics strong {
		font-size: 30px;
		margin-top: 6px;
	}
	table {
		border-collapse: collapse;
		width: 100%;
		margin: 16px 0 20px;
	}
	th,
	td {
		text-align: left;
		padding: 12px;
		border-bottom: 1px solid var(--line, #ccd4ce);
	}
	@media (max-width: 600px) {
		table {
			font-size: 12px;
		}
		th,
		td {
			padding: 8px 4px;
		}
	}
</style>
