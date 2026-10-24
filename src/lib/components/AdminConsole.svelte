<script lang="ts">
	import { onMount } from 'svelte';
	import { KeyRound, Plus, RefreshCw, Shield, Webhook, X } from 'lucide-svelte';
	let { tenant } = $props<{ tenant: string }>();
	let tokens = $state<any[]>([]),
		endpoints = $state<any[]>([]),
		events = $state<string[]>([]),
		retention = $state<any>({
			enabled: false,
			aiRetentionDays: 365,
			webhookDeliveryRetentionDays: 365
		}),
		loading = $state(true),
		busy = $state(false),
		error = $state(''),
		notice = $state(''),
		newToken = $state(''),
		newWebhookSecret = $state(''),
		tokenLabel = $state(''),
		tokenPermissions = $state<string[]>(['contacts:read']),
		tokenExpiry = $state(''),
		webhookLabel = $state(''),
		webhookUrl = $state(''),
		webhookEvents = $state<string[]>(['contacts.created']),
		webhookApproved = $state(false);
	onMount(load);
	async function request(path: string, init?: RequestInit) {
		const response = await fetch(path, {
			...init,
			headers: { 'content-type': 'application/json', ...(init?.headers || {}) }
		});
		const data = await response.json();
		if (!response.ok) throw new Error(data.error || 'Administration request failed.');
		return data;
	}
	async function load() {
		loading = true;
		error = '';
		try {
			const [tokenData, webhookData, retentionData] = await Promise.all([
				request('/api/v1/admin/tokens'),
				request('/api/v1/admin/webhooks'),
				request('/api/v1/admin/retention')
			]);
			tokens = tokenData.tokens;
			endpoints = webhookData.endpoints;
			events = webhookData.events;
			retention = retentionData.policy;
		} catch (e) {
			error = e instanceof Error ? e.message : 'Workspace administration unavailable.';
		} finally {
			loading = false;
		}
	}
	async function createToken(event: SubmitEvent) {
		event.preventDefault();
		busy = true;
		error = '';
		notice = '';
		try {
			const result = await request('/api/v1/admin/tokens', {
				method: 'POST',
				body: JSON.stringify({
					label: tokenLabel,
					permissions: tokenPermissions,
					...(tokenExpiry ? { expiresAt: new Date(tokenExpiry + 'T23:59:59Z').toISOString() } : {})
				})
			});
			newToken = result.token;
			tokenLabel = '';
			tokenExpiry = '';
			await load();
			notice = 'Copy the token now. It cannot be shown again.';
		} catch (e) {
			error = e instanceof Error ? e.message : 'Token could not be created.';
		} finally {
			busy = false;
		}
	}
	async function revokeToken(id: string) {
		if (!confirm('Revoke this API token now? Existing integrations will stop working.')) return;
		busy = true;
		error = '';
		try {
			await request('/api/v1/admin/tokens/' + id, { method: 'DELETE' });
			await load();
		} catch (e) {
			error = e instanceof Error ? e.message : 'Token could not be revoked.';
		} finally {
			busy = false;
		}
	}
	async function createWebhook(event: SubmitEvent) {
		event.preventDefault();
		busy = true;
		error = '';
		notice = '';
		try {
			const result = await request('/api/v1/admin/webhooks', {
				method: 'POST',
				body: JSON.stringify({
					label: webhookLabel,
					url: webhookUrl,
					events: webhookEvents,
					approved: webhookApproved
				})
			});
			newWebhookSecret = result.secret;
			webhookLabel = '';
			webhookUrl = '';
			webhookApproved = false;
			await load();
			notice = 'The signing secret is shown once. Copy it into your receiver now.';
		} catch (e) {
			error = e instanceof Error ? e.message : 'Webhook could not be created.';
		} finally {
			busy = false;
		}
	}
	async function revokeWebhook(id: string) {
		if (!confirm('Disable this webhook and stop future delivery?')) return;
		busy = true;
		error = '';
		try {
			await request('/api/v1/admin/webhooks/' + id, { method: 'DELETE' });
			await load();
		} catch (e) {
			error = e instanceof Error ? e.message : 'Webhook could not be disabled.';
		} finally {
			busy = false;
		}
	}
	async function saveRetention(event: SubmitEvent) {
		event.preventDefault();
		busy = true;
		error = '';
		notice = '';
		try {
			const result = await request('/api/v1/admin/retention', {
				method: 'PUT',
				body: JSON.stringify({
					enabled: retention.enabled,
					aiRetentionDays: Number(retention.aiRetentionDays),
					webhookDeliveryRetentionDays: Number(retention.webhookDeliveryRetentionDays)
				})
			});
			retention = result.policy;
			notice = 'Retention policy saved.';
		} catch (e) {
			error = e instanceof Error ? e.message : 'Retention policy could not be saved.';
		} finally {
			busy = false;
		}
	}
	function toggle(list: string[], value: string) {
		return list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
	}
</script>

<svelte:head><title>Integrations & access · {tenant} · GiveLoom</title></svelte:head>
<section class="admin-console" aria-labelledby="admin-title">
	<header>
		<span class="eyebrow">WORKSPACE CONTROL</span>
		<h1 id="admin-title">Integrations & access<span>.</span></h1>
		<p>
			Scoped API credentials, approved event destinations, and optional retention controls for this
			workspace.
		</p>
		<div class="header-actions">
			<a class="secondary" href={'/app/' + tenant + '/settings/general'}>Back to settings</a><button
				class="secondary"
				onclick={load}
				disabled={loading}><RefreshCw size={15} /> Refresh</button
			>
		</div>
	</header>
	{#if error}<p class="banner error" role="alert">{error}</p>{/if}{#if notice}<p
			class="banner success"
			role="status"
		>
			{notice}
		</p>{/if}{#if loading}<p aria-busy="true">Loading workspace controls…</p>{:else}
		{#if newToken}<div class="secret-box" role="status">
				<strong>New API token</strong><code>{newToken}</code><button
					aria-label="Hide API token"
					class="icon-button"
					onclick={() => (newToken = '')}><X size={16} /></button
				>
				<p>Store it in your secret manager. It will not appear again.</p>
			</div>{/if}
		{#if newWebhookSecret}<div class="secret-box" role="status">
				<strong>Webhook signing secret</strong><code>{newWebhookSecret}</code><button
					aria-label="Hide webhook secret"
					class="icon-button"
					onclick={() => (newWebhookSecret = '')}><X size={16} /></button
				>
				<p>Configure the receiver to verify the timestamped HMAC signature.</p>
			</div>{/if}
		<div class="control-grid">
			<section class="control-section">
				<div class="section-title">
					<KeyRound size={19} />
					<div>
						<h2>API tokens</h2>
						<p>
							Tokens inherit the creator’s active tenant role and receive only the scopes selected
							here.
						</p>
					</div>
				</div>
				<form class="form-stack" onsubmit={createToken}>
					<label
						>Token label<input
							required
							maxlength="120"
							bind:value={tokenLabel}
							placeholder="Finance export job"
						/></label
					><label>Optional expiry<input type="date" bind:value={tokenExpiry} /></label>
					<fieldset>
						<legend>Permissions</legend
						>{#each [{ key: 'contacts:read', label: 'Read contacts' }, { key: 'giving:read', label: 'Read giving ledger' }, { key: 'giving:write', label: 'Record giving events' }] as permission}<label
								class="check"
								><input
									type="checkbox"
									checked={tokenPermissions.includes(permission.key)}
									onchange={() => (tokenPermissions = toggle(tokenPermissions, permission.key))}
								/>{permission.label}</label
							>{/each}
					</fieldset>
					<button class="primary" disabled={busy || !tokenPermissions.length}
						><Plus size={15} />Create scoped token</button
					>
				</form>
				<div class="record-list">
					{#each tokens as token (token.id)}<article>
							<div>
								<strong>{token.label}</strong><code>{token.tokenPrefix}…</code><small
									>{token.permissions.join(' · ')} · {token.revokedAt
										? 'Revoked'
										: token.expiresAt
											? 'Expires ' + new Date(token.expiresAt).toLocaleDateString()
											: 'No expiry'} · Last used {token.lastUsedAt
										? new Date(token.lastUsedAt).toLocaleString()
										: 'Never'}</small
								>
							</div>
							{#if !token.revokedAt}<button
									class="text-button danger"
									onclick={() => revokeToken(token.id)}>Revoke</button
								>{/if}
						</article>{:else}<p class="empty-inline">No API tokens have been created.</p>{/each}
				</div>
			</section>
			<section class="control-section">
				<div class="section-title">
					<Webhook size={19} />
					<div>
						<h2>Outbound webhooks</h2>
						<p>
							New destinations require explicit approval. Requests use HTTPS, public DNS addresses,
							signatures, and bounded retries.
						</p>
					</div>
				</div>
				<form class="form-stack" onsubmit={createWebhook}>
					<label
						>Destination label<input
							required
							maxlength="120"
							bind:value={webhookLabel}
							placeholder="Accounting sync"
						/></label
					><label
						>Public HTTPS URL<input
							type="url"
							required
							bind:value={webhookUrl}
							placeholder="https://hooks.example.org/giveloom"
						/></label
					>
					<fieldset>
						<legend>Events</legend>
						<div class="event-list">
							{#each events as event}<label class="check"
									><input
										type="checkbox"
										checked={webhookEvents.includes(event)}
										onchange={() => (webhookEvents = toggle(webhookEvents, event))}
									/>{event}</label
								>{/each}
						</div>
					</fieldset>
					<label class="check approval"
						><input type="checkbox" required bind:checked={webhookApproved} />I reviewed and approve
						sending these event notices to this destination.</label
					><button class="primary" disabled={busy || !webhookEvents.length}
						><Plus size={15} />Approve and add destination</button
					>
				</form>
				<div class="record-list">
					{#each endpoints as endpoint (endpoint.id)}<article class="webhook-record">
							<div>
								<strong>{endpoint.label}</strong><code>{endpoint.targetUrl}</code><small
									>{endpoint.enabled && !endpoint.revokedAt ? 'Enabled' : 'Disabled'} · {endpoint.events.join(
										', '
									)}</small
								>
								<details>
									<summary>Recent delivery log ({endpoint.deliveryCount})</summary
									>{#each endpoint.deliveries || [] as delivery}<p>
											{delivery.eventType} · {delivery.status} · {delivery.attempts} attempts {delivery.responseStatus
												? '· HTTP ' + delivery.responseStatus
												: ''}{#if delivery.lastError}<small>{delivery.lastError}</small>{/if}
										</p>{:else}<p>No deliveries yet.</p>{/each}
								</details>
							</div>
							{#if endpoint.enabled && !endpoint.revokedAt}<button
									class="text-button danger"
									onclick={() => revokeWebhook(endpoint.id)}>Disable</button
								>{/if}
						</article>{:else}<p class="empty-inline">No outbound webhook destinations.</p>{/each}
				</div>
			</section>
			<section class="control-section retention">
				<div class="section-title">
					<Shield size={19} />
					<div>
						<h2>Optional retention cleanup</h2>
						<p>
							Disabled by default. When enabled, scheduled cleanup removes only expired AI
							conversation/audit data and old webhook delivery logs. Financial and donor records are
							retained.
						</p>
					</div>
				</div>
				<form class="form-stack" onsubmit={saveRetention}>
					<label class="check approval"
						><input type="checkbox" bind:checked={retention.enabled} />Enable scheduled retention
						cleanup</label
					>
					<div class="field-pair">
						<label
							>AI data (days)<input
								type="number"
								min="30"
								max="3650"
								bind:value={retention.aiRetentionDays}
							/></label
						><label
							>Webhook logs (days)<input
								type="number"
								min="90"
								max="3650"
								bind:value={retention.webhookDeliveryRetentionDays}
							/></label
						>
					</div>
					<button class="primary" disabled={busy}>Save retention policy</button>
				</form>
			</section>
		</div>{/if}
</section>

<style>
	.admin-console {
		max-width: 1120px;
		margin: 0 auto;
		padding: clamp(22px, 5vw, 56px);
		color: var(--ink);
	}
	header {
		position: relative;
		padding-bottom: 26px;
		border-bottom: 1px solid var(--line);
	}
	header h1 {
		font-size: clamp(30px, 4vw, 48px);
		margin: 8px 0;
	}
	header h1 span {
		color: var(--accent);
	}
	header p {
		max-width: 740px;
		color: var(--muted);
		line-height: 1.6;
	}
	.header-actions {
		position: absolute;
		right: 0;
		top: 0;
		display: flex;
		gap: 8px;
	}
	.control-grid {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 32px;
		padding-top: 30px;
	}
	.control-section {
		min-width: 0;
		border-bottom: 1px solid var(--line);
		padding-bottom: 28px;
	}
	.section-title {
		display: flex;
		gap: 13px;
		align-items: flex-start;
	}
	.section-title :global(svg) {
		color: var(--accent);
		margin-top: 5px;
		flex: none;
	}
	.section-title h2 {
		margin: 0 0 5px;
		font-size: 21px;
	}
	.section-title p {
		margin: 0 0 18px;
		color: var(--muted);
		font-size: 13px;
		line-height: 1.55;
	}
	.form-stack {
		display: grid;
		gap: 12px;
		margin: 18px 0 24px;
	}
	.form-stack label:not(.check) {
		display: grid;
		gap: 6px;
		font-size: 12px;
		color: var(--muted);
	}
	.form-stack input:not([type='checkbox']) {
		width: 100%;
		padding: 10px;
		border: 1px solid var(--line);
		background: var(--paper);
		color: var(--ink);
	}
	fieldset {
		border: 0;
		padding: 0;
		margin: 0;
	}
	legend {
		font-size: 12px;
		font-weight: 700;
		margin-bottom: 8px;
	}
	.check {
		display: flex;
		align-items: flex-start;
		gap: 8px;
		font-size: 12px;
		line-height: 1.45;
		color: var(--muted);
	}
	.check input {
		accent-color: var(--accent);
		margin-top: 2px;
	}
	.event-list {
		max-height: 140px;
		overflow: auto;
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 8px;
	}
	.approval {
		padding: 10px;
		background: color-mix(in srgb, var(--accent) 8%, transparent);
	}
	.record-list {
		display: grid;
	}
	.record-list article {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 15px;
		border-top: 1px solid var(--line);
		padding: 13px 0;
	}
	.record-list article > div {
		min-width: 0;
	}
	.record-list strong,
	.record-list code,
	.record-list small {
		display: block;
	}
	.record-list code {
		font-size: 11px;
		overflow-wrap: anywhere;
		color: var(--muted);
		margin: 5px 0;
	}
	.record-list small {
		font-size: 10px;
		color: var(--muted);
		line-height: 1.5;
	}
	.record-list details {
		margin-top: 8px;
		font-size: 11px;
	}
	.record-list details p {
		margin: 7px 0;
	}
	.danger {
		color: #a13a32;
	}
	.secret-box {
		display: grid;
		grid-template-columns: 1fr auto;
		gap: 8px;
		margin: 18px 0;
		padding: 15px;
		border: 1px solid var(--accent);
		background: color-mix(in srgb, var(--accent) 7%, var(--paper));
	}
	.secret-box code {
		grid-column: 1/2;
		overflow-wrap: anywhere;
	}
	.secret-box p {
		grid-column: 1/2;
		margin: 0;
		color: var(--muted);
		font-size: 12px;
	}
	.secret-box button {
		grid-column: 2;
		grid-row: 1;
	}
	.retention {
		grid-column: 1/-1;
	}
	.field-pair {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 12px;
	}
	.empty-inline {
		color: var(--muted);
		font-size: 13px;
		padding: 12px 0;
	}
	@media (max-width: 760px) {
		.control-grid {
			grid-template-columns: 1fr;
		}
		.retention {
			grid-column: auto;
		}
		.header-actions {
			position: static;
			margin-top: 12px;
			flex-wrap: wrap;
		}
		.field-pair {
			grid-template-columns: 1fr;
		}
		.event-list {
			grid-template-columns: 1fr;
		}
	}
</style>
