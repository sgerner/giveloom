<script lang="ts">
	import { onMount } from 'svelte';

	type InstallPromptEvent = Event & {
		prompt: () => Promise<void>;
		userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
	};
	let installEvent: InstallPromptEvent | undefined = $state();
	let registration: ServiceWorkerRegistration | undefined = $state();
	let updateReady = $state(false);
	let iosInstallHelp = $state(false);
	let standalone = $state(false);

	onMount(() => {
		if (typeof window === 'undefined') return;
		const displayMode = window.matchMedia('(display-mode: standalone)');
		const refreshStandalone = () => {
			standalone =
				displayMode.matches ||
				Boolean((navigator as Navigator & { standalone?: boolean }).standalone);
		};
		refreshStandalone();
		displayMode.addEventListener('change', refreshStandalone);

		const isIos =
			/iphone|ipad|ipod/i.test(navigator.userAgent) ||
			(navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
		const showIosHelp = () => {
			if (!standalone && isIos) iosInstallHelp = true;
		};
		const handleInstall = (event: Event) => {
			event.preventDefault();
			installEvent = event as InstallPromptEvent;
		};
		window.addEventListener('beforeinstallprompt', handleInstall);
		showIosHelp();

		let disposed = false;
		if ('serviceWorker' in navigator) {
			void navigator.serviceWorker
				.register('/service-worker.js')
				.then((worker) => {
					if (disposed) return;
					registration = worker;
					if (worker.waiting && navigator.serviceWorker.controller) updateReady = true;
					worker.addEventListener('updatefound', () => {
						const installing = worker.installing;
						installing?.addEventListener('statechange', () => {
							if (installing.state === 'installed' && navigator.serviceWorker.controller)
								updateReady = true;
						});
					});
					void worker.update().catch(() => undefined);
				})
				.catch(() => undefined);
		}

		return () => {
			disposed = true;
			displayMode.removeEventListener('change', refreshStandalone);
			window.removeEventListener('beforeinstallprompt', handleInstall);
		};
	});

	async function install() {
		if (!installEvent) return;
		const event = installEvent;
		installEvent = undefined;
		await event.prompt();
		const choice = await event.userChoice;
		if (choice.outcome === 'accepted') iosInstallHelp = false;
	}

	function update() {
		const waiting = registration?.waiting;
		if (!waiting) return;
		waiting.postMessage({ type: 'SKIP_WAITING' });
		updateReady = false;
		waiting.addEventListener('statechange', () => {
			if (waiting.state === 'activated') window.location.reload();
		});
	}
</script>

{#if updateReady || (!standalone && (installEvent || iosInstallHelp))}
	<aside class="pwa-notice" aria-label="App options" aria-live="polite">
		{#if updateReady}
			<p>A Donor CRM update is ready. Updating reloads the app; save any edits first.</p>
			<button type="button" onclick={update}>Update now</button>
		{:else if installEvent}
			<p>Add Donor CRM to your home screen for a focused workspace.</p>
			<button type="button" onclick={install}>Install app</button>
			<button
				class="quiet"
				type="button"
				onclick={() => (installEvent = undefined)}
				aria-label="Dismiss install suggestion">Later</button
			>
		{:else if iosInstallHelp}
			<p>To add Donor CRM on iPhone or iPad, tap Share, then “Add to Home Screen.”</p>
			<button
				class="quiet"
				type="button"
				onclick={() => (iosInstallHelp = false)}
				aria-label="Dismiss install instructions">Dismiss</button
			>
		{/if}
	</aside>
{/if}

<style>
	.pwa-notice {
		position: fixed;
		z-index: 50;
		inset-inline: 1rem;
		bottom: max(1rem, env(safe-area-inset-bottom));
		margin-inline: auto;
		max-width: 34rem;
		display: flex;
		align-items: center;
		gap: 0.75rem;
		flex-wrap: wrap;
		padding: 0.85rem 1rem;
		color: var(--ink);
		background: var(--paper);
		border: 1px solid var(--line);
		box-shadow: 0 8px 32px rgb(39 61 52 / 14%);
	}
	.pwa-notice p {
		flex: 1 1 14rem;
		margin: 0;
	}
	button {
		min-height: 2.75rem;
		padding: 0.55rem 0.9rem;
		border: 0;
		background: var(--accent);
		color: var(--paper);
		font: inherit;
		cursor: pointer;
	}
	button:focus-visible {
		outline: 3px solid var(--coral);
		outline-offset: 3px;
	}
	button.quiet {
		padding-inline: 0.5rem;
		background: transparent;
		color: inherit;
		text-decoration: underline;
	}
	@media (prefers-reduced-motion: reduce) {
		*,
		*::before,
		*::after {
			scroll-behavior: auto !important;
		}
	}
</style>
