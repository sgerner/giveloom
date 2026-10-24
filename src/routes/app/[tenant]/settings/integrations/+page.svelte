<script lang="ts">
	import AdminConsole from '$lib/components/AdminConsole.svelte';
	let { data } = $props<{ data: { tenant: string } }>();
</script>

<AdminConsole tenant={data.tenant} />
