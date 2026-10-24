<script lang="ts">
	import '../app.css';
	import { onMount } from 'svelte';
	import { themes } from '$lib/themes';
	onMount(() => {
		const apply = () => {
			const theme = localStorage.getItem('crm-theme') || 'donor-crm';
			document.documentElement.dataset.theme =
				theme === 'donor-crm' || themes.includes(theme as (typeof themes)[number])
					? theme
					: 'donor-crm';
			const mode = localStorage.getItem('crm-mode') || 'system';
			document.documentElement.classList.toggle(
				'dark',
				mode === 'dark' || (mode === 'system' && matchMedia('(prefers-color-scheme: dark)').matches)
			);
		};
		apply();
		const media = matchMedia('(prefers-color-scheme: dark)');
		media.addEventListener('change', apply);
		return () => media.removeEventListener('change', apply);
	});
	import PwaPrompt from '$lib/components/PwaPrompt.svelte';
	let { children } = $props();
</script>

{@render children()}
<PwaPrompt />
