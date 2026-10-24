<script lang="ts">
	import { ArrowRight, Sprout } from 'lucide-svelte';
	let { data } = $props();
	const amount = (value: number) =>
		new Intl.NumberFormat(undefined, {
			style: 'currency',
			currency: 'USD',
			maximumFractionDigits: 0
		}).format(Number(value || 0) / 100);
	const progress = $derived(
		data.goalMinor > 0
			? Math.min(100, Math.round((Number(data.raisedMinor) * 100) / Number(data.goalMinor)))
			: 0
	);
</script>

<svelte:head
	><title>{data.name} · {data.campaignName}</title><meta
		name="description"
		content={data.story}
	/><meta name="robots" content="noindex" /></svelte:head
>
<main class="peer-page">
	<header>
		<a href="/" class="brand"
			><img src="/brand/generous-dots.svg" alt="" width="34" height="34" />{data.organization}</a
		><span class="eyebrow">PEER FUNDRAISING</span>
	</header>
	<section class="hero">
		<span class="eyebrow"
			>{data.pageType === 'team' ? 'A TEAM GROWING GOOD' : 'A FRIEND GROWING GOOD'}</span
		>
		<h1>{data.name}<span class="dot">.</span></h1>
		<p class="campaign-name">Supporting {data.campaignName}</p>
		<div class="story">
			{#each data.story.split('\n').filter(Boolean) as paragraph}<p>{paragraph}</p>{/each}
		</div>
		<div class="progress">
			<div class="progress-label">
				<strong>{amount(data.raisedMinor)} raised</strong><span>{amount(data.goalMinor)} goal</span>
			</div>
			<progress max="100" value={progress} aria-label={`${progress}% of fundraising goal`}
			></progress>
		</div>
		<a
			class="give"
			href={`/donate/${encodeURIComponent(data.tenant)}/${encodeURIComponent(data.campaignId)}?fundraiser=${encodeURIComponent(data.id)}`}
			>Support this page <ArrowRight size={17} /></a
		>
	</section>
	<footer><Sprout size={18} /> A little connection. A lasting difference.</footer>
</main>

<style>
	.peer-page {
		max-width: 760px;
		margin: auto;
		padding: clamp(1rem, 5vw, 3.5rem);
		min-height: 100vh;
		color: var(--ink);
	}
	header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding-bottom: 1rem;
		border-bottom: 1px solid var(--line);
	}
	.brand {
		display: flex;
		align-items: center;
		gap: 0.65rem;
		font-weight: 600;
	}
	.brand img {
		width: 34px;
	}
	.eyebrow {
		font-size: 0.68rem;
		letter-spacing: 0.13em;
		color: var(--muted);
		text-transform: uppercase;
	}
	.hero {
		padding: clamp(3rem, 9vw, 7rem) 0 3rem;
	}
	.hero h1 {
		margin: 0.6rem 0;
	}
	.dot {
		color: var(--coral);
	}
	.campaign-name {
		color: var(--muted);
	}
	.story {
		font-family: Georgia, serif;
		font-size: 1.12rem;
		line-height: 1.8;
		margin: 2rem 0;
	}
	.story p + p {
		margin-top: 1rem;
	}
	.progress {
		margin: 2.5rem 0 1.5rem;
	}
	.progress-label {
		display: flex;
		justify-content: space-between;
		gap: 1rem;
		margin-bottom: 0.6rem;
	}
	.progress-label span {
		color: var(--muted);
	}
	progress {
		width: 100%;
		height: 12px;
		accent-color: var(--accent);
	}
	.give {
		display: inline-flex;
		align-items: center;
		gap: 0.6rem;
		background: var(--accent);
		color: var(--paper);
		padding: 0.85rem 1.1rem;
		min-height: 48px;
	}
	footer {
		border-top: 1px solid var(--line);
		padding: 1.3rem 0;
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 0.5rem;
		color: var(--muted);
		font-size: 0.8rem;
	}
</style>
