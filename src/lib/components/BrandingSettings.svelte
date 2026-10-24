<script lang="ts">
	import { onMount } from 'svelte';
	import { themes } from '$lib/themes';
	let { demo = false } = $props<{ demo?: boolean }>();
	type Branding = {
		legalName: string;
		taxId: string;
		timezone: string;
		locale: string;
		publicName: string;
		theme: string;
		logoAssetId: string | null;
		logoPublic: boolean;
		logoUrl: string | null;
	};
	const blank: Branding = {
		legalName: '',
		taxId: '',
		timezone: 'UTC',
		locale: 'en-US',
		publicName: '',
		theme: themes[0],
		logoAssetId: null,
		logoPublic: false,
		logoUrl: null
	};
	let form = $state<Branding>({ ...blank }),
		busy = $state(false),
		loading = $state(true),
		error = $state(''),
		notice = $state(''),
		preview = $state('');
	async function request(url: string, method = 'GET', body?: unknown) {
		const response = await fetch(url, {
			method,
			headers: body ? { 'content-type': 'application/json' } : undefined,
			body: body ? JSON.stringify(body) : undefined
		});
		const data = await response.json();
		if (!response.ok) throw new Error(data.error || 'Request failed.');
		return data;
	}
	async function load() {
		if (demo) {
			loading = false;
			return;
		}
		loading = true;
		error = '';
		try {
			const data = await request('/api/v1/branding');
			form = { ...blank, ...data.branding };
		} catch (e) {
			error = e instanceof Error ? e.message : 'Brand settings could not be loaded.';
		} finally {
			loading = false;
		}
	}
	async function save() {
		busy = true;
		error = '';
		notice = '';
		try {
			const data = await request('/api/v1/branding', 'PUT', form);
			form = { ...blank, ...data.branding };
			notice = 'Workspace identity and public display settings saved.';
		} catch (e) {
			error = e instanceof Error ? e.message : 'Brand settings could not be saved.';
		} finally {
			busy = false;
		}
	}
	async function upload(event: Event) {
		const input = event.currentTarget as HTMLInputElement,
			file = input.files?.[0];
		if (!file) return;
		busy = true;
		error = '';
		notice = '';
		try {
			const body = new FormData();
			body.set('file', file);
			const response = await fetch('/api/v1/branding/logo', { method: 'POST', body });
			const data = await response.json();
			if (!response.ok) throw new Error(data.error || 'Logo could not be uploaded.');
			form.logoAssetId = data.logo.id;
			form.logoPublic = false;
			preview = URL.createObjectURL(file);
			notice =
				'Logo uploaded and scanned. Save changes, then explicitly enable public display to show it.';
		} catch (e) {
			error = e instanceof Error ? e.message : 'Logo could not be uploaded.';
		} finally {
			busy = false;
			input.value = '';
		}
	}
	onMount(() => {
		void load();
		return () => {
			if (preview) URL.revokeObjectURL(preview);
		};
	});
</script>

<section class="branding" aria-labelledby="branding-title">
	<header>
		<p class="eyebrow">WORKSPACE IDENTITY</p>
		<h2 id="branding-title">Organization and brand</h2>
		<p>
			Set the legal details used by your team and how your organization appears on public giving and
			event pages.
		</p>
	</header>
	{#if demo}<p class="notice" role="status">
			Brand settings can be edited after you sign in to a persistent workspace.
		</p>
	{:else if loading}<p role="status">Loading brand settings…</p>
	{:else}<form
			onsubmit={(event) => {
				event.preventDefault();
				void save();
			}}
		>
			{#if error}<p class="error" role="alert">{error}</p>{/if}{#if notice}<p
					class="notice"
					role="status"
				>
					{notice}
				</p>{/if}
			<div class="fields">
				<label
					>Legal organization name<input
						required
						minlength="2"
						maxlength="180"
						bind:value={form.legalName}
					/></label
				><label
					>Public display name<input
						required
						minlength="2"
						maxlength="120"
						bind:value={form.publicName}
					/></label
				><label
					>Tax ID (optional)<input
						maxlength="40"
						autocomplete="off"
						bind:value={form.taxId}
					/><small>Visible only to workspace owners and admins.</small></label
				><label
					>Time zone<input
						required
						maxlength="80"
						bind:value={form.timezone}
						placeholder="America/Phoenix"
					/><small>Use an IANA time zone such as America/Phoenix.</small></label
				><label
					>Locale<input
						required
						maxlength="32"
						bind:value={form.locale}
						placeholder="en-US"
					/></label
				><label
					>Public color theme<select bind:value={form.theme}
						>{#each themes as theme}<option value={theme}>{theme}</option>{/each}</select
					><small>Theme options come from the installed Skeleton theme set.</small></label
				>
			</div>
			<section class="logo" aria-labelledby="logo-title">
				<div>
					<h3 id="logo-title">Organization logo</h3>
					<p>PNG, JPEG, or WebP up to 3 MiB. Public display is off until you turn it on below.</p>
					<label
						>Upload a logo<input
							type="file"
							accept="image/png,image/jpeg,image/webp"
							onchange={upload}
							disabled={busy}
						/></label
					>
				</div>
				{#if preview || form.logoUrl}<img
						src={preview || form.logoUrl || ''}
						alt="Organization logo preview"
					/>{:else}<div class="logo-placeholder" aria-hidden="true">Logo preview</div>{/if}
			</section>
			<label class="consent"
				><input type="checkbox" bind:checked={form.logoPublic} disabled={!form.logoAssetId} />
				<span
					><strong>Display this logo publicly</strong><small
						>Show it on public donation, event, and donor portal pages. This is explicit permission
						to publish the uploaded image.</small
					></span
				></label
			>
			<button class="primary" disabled={busy}>{busy ? 'Saving…' : 'Save brand settings'}</button>
		</form>{/if}
</section>

<style>
	.branding {
		display: grid;
		gap: 1rem;
		max-width: 920px;
	}
	.branding header h2 {
		margin: 0.15rem 0;
	}
	.branding header p,
	.branding small,
	.branding .logo p {
		color: var(--muted, #66736c);
	}
	.eyebrow {
		font-size: 0.7rem;
		letter-spacing: 0.12em;
		color: var(--muted, #61786e);
		margin: 0;
	}
	.fields {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(15rem, 1fr));
		gap: 0.85rem;
	}
	.fields label,
	.logo label {
		display: grid;
		gap: 0.35rem;
	}
	.fields input,
	.fields select,
	.logo input[type='file'] {
		font: inherit;
		min-height: 2.6rem;
		border: 1px solid var(--border, #cfd9d3);
		border-radius: 0.45rem;
		padding: 0.45rem 0.6rem;
		background: var(--surface, #fff);
		color: inherit;
	}
	.branding form {
		display: grid;
		gap: 1rem;
	}
	.logo {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 1rem;
		border-top: 1px solid var(--border, #dce4df);
		border-bottom: 1px solid var(--border, #dce4df);
		padding: 1rem 0;
	}
	.logo h3,
	.logo p {
		margin: 0.2rem 0 0.6rem;
	}
	.logo img,
	.logo-placeholder {
		width: 140px;
		height: 100px;
		object-fit: contain;
		border: 1px solid var(--border, #dce4df);
		padding: 0.4rem;
		border-radius: 0.3rem;
		background: var(--surface, #fff);
	}
	.logo-placeholder {
		display: grid;
		place-items: center;
		color: var(--muted, #66736c);
		font-size: 0.85rem;
	}
	.consent {
		display: flex;
		gap: 0.65rem;
		align-items: flex-start;
	}
	.consent input {
		margin-top: 0.25rem;
	}
	.consent span {
		display: grid;
		gap: 0.25rem;
	}
	.consent small {
		max-width: 55rem;
	}
	.primary {
		justify-self: start;
		padding: 0.65rem 1rem;
		border: 0;
		border-radius: 0.4rem;
		background: var(--color-primary, #2c6049);
		color: #fff;
		font: inherit;
		cursor: pointer;
	}
	.primary:disabled {
		opacity: 0.55;
	}
	.notice,
	.error {
		padding: 0.7rem 0.85rem;
		margin: 0;
		border-radius: 0.35rem;
	}
	.notice {
		background: #eef6f0;
		color: #315b45;
	}
	.error {
		background: #fff0eb;
		color: #902e1e;
	}
	@media (max-width: 600px) {
		.logo {
			align-items: flex-start;
			flex-direction: column;
		}
	}
</style>
