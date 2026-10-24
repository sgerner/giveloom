<script lang="ts">
	let { data } = $props();
</script>

<svelte:head><title>Platform audit · Donor CRM</title></svelte:head>
<main class="platform">
	<nav>
		<a href="/platform/tenants">Tenants</a> · <a href="/platform/health">Health</a> ·
		<a href="/platform/audit" aria-current="page">Audit</a>
	</nav>
	<h1>Platform audit</h1>
	<p>Operator actions and tenant lifecycle changes. Donor information is excluded.</p>
	<table>
		<thead><tr><th>When</th><th>Action</th><th>Tenant</th><th>Actor</th></tr></thead><tbody
			>{#each data.items as item}<tr
					><td>{new Date(item.createdAt).toLocaleString()}</td><td>{item.action}</td><td
						>{item.tenantId}</td
					><td>{item.actorId}</td></tr
				>{:else}<tr><td colspan="4">No platform actions recorded.</td></tr>{/each}</tbody
		>
	</table>
</main>

<style>
	.platform {
		max-width: 1100px;
		margin: 3rem auto;
		padding: 1rem;
	}
	table {
		width: 100%;
		text-align: left;
		border-collapse: collapse;
	}
	td,
	th {
		padding: 1rem;
		border-bottom: 1px solid var(--line);
	}
</style>
