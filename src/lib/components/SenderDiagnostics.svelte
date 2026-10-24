<script lang="ts">
	import { onMount } from 'svelte';
	let { demo = false } = $props<{ demo?: boolean }>();
	let result = $state<any>(null),
		busy = $state(false),
		error = $state('');
	async function refresh() {
		busy = true;
		error = '';
		try {
			const response = await fetch('/api/v1/integrations/ses/diagnostics', {
				headers: { accept: 'application/json' }
			});
			const data = await response.json();
			if (!response.ok) throw new Error(data.error || 'Sender diagnostics are unavailable.');
			result = data;
		} catch (e) {
			error = e instanceof Error ? e.message : 'Sender diagnostics are unavailable.';
		} finally {
			busy = false;
		}
	}
	onMount(() => {
		if (!demo) void refresh();
	});
</script>

<section class="sender-diagnostics" aria-labelledby="sender-diagnostics-title">
	<header>
		<div>
			<p class="eyebrow">EMAIL AUTHENTICATION</p>
			<h3 id="sender-diagnostics-title">Sender diagnostics</h3>
			<p>
				Read-only SES checks for verified identities, domain DNS, sandbox access, and sending quota.
			</p>
		</div>
		<button type="button" disabled={busy || demo} onclick={refresh}
			>{busy ? 'Checking…' : 'Refresh checks'}</button
		>
	</header>
	{#if demo}<p class="notice">Live sender diagnostics are disabled in demo mode.</p>
	{:else if error}<p class="error" role="alert">{error}</p>
	{:else if !result}<p class="muted" role="status">
			{busy ? 'Checking SES and DNS…' : 'Diagnostics have not been loaded.'}
		</p>
	{:else if !result.configured}<p class="notice">
			Configure SES in the Email integration settings to run sender checks.
		</p>
	{:else}
		<p class="muted">
			Region: <strong>{result.region}</strong> · Sender: <strong>{result.sender?.address}</strong> · Credentials
			remain encrypted and are never shown here.
		</p>
		<div class="checks">
			<article>
				<h4>SES identity</h4>
				<dl>
					<dt>Sender verified</dt>
					<dd>{result.sender?.verifiedForSending ? 'Verified' : 'Not verified'}</dd>
					<dt>Domain verified</dt>
					<dd>{result.domain?.verified ? 'Verified' : result.domain?.verificationStatus}</dd>
					<dt>DKIM signing</dt>
					<dd>
						{result.domain?.dkimEnabled ? 'Enabled' : 'Disabled'} · {result.domain?.dkimStatus}
					</dd>
					<dt>Custom MAIL FROM</dt>
					<dd>
						{result.domain?.mailFromDomain || 'Not configured'} · {result.domain?.mailFromStatus}
					</dd>
				</dl>
			</article>
			<article>
				<h4>DNS records for {result.domain?.name}</h4>
				<dl>
					<dt>SPF TXT</dt>
					<dd>{result.dns?.spf?.configured ? 'Found' : 'Not detected'}</dd>
					<dt>DMARC TXT</dt>
					<dd>{result.dns?.dmarc?.configured ? 'Found' : 'Not detected'}</dd>
				</dl>
				{#if result.domain?.dkimEnabled}<ul aria-label="DKIM CNAME verification">
						{#each result.dns?.dkim || [] as record}<li>
								<code>{record.name}</code> · {record.status}
							</li>{:else}<li>SES did not return DKIM tokens for this domain.</li>{/each}
					</ul>{/if}
			</article>
			<article>
				<h4>Sending account</h4>
				<dl>
					<dt>Mode</dt>
					<dd>{result.quota?.sandbox ? 'Sandbox' : 'Production'}</dd>
					<dt>24-hour quota</dt>
					<dd>
						{result.quota?.sentLast24Hours} sent · {result.quota?.remaining24Hour} remaining of {result
							.quota?.max24HourSend}
					</dd>
					<dt>Rate limit</dt>
					<dd>{result.quota?.maxSendRate} messages per second</dd>
				</dl>
			</article>
		</div>
	{/if}
</section>

<style>
	.sender-diagnostics {
		display: grid;
		gap: 1rem;
		border: 1px solid #dce5e0;
		border-radius: 12px;
		padding: 1rem;
		background: #fff;
		color: #18382f;
	}
	.sender-diagnostics header {
		display: flex;
		justify-content: space-between;
		align-items: flex-start;
		gap: 1rem;
	}
	.eyebrow {
		font-size: 0.7rem;
		letter-spacing: 0.12em;
		color: #56746a;
		margin: 0 0 0.3rem;
	}
	.sender-diagnostics h3,
	.sender-diagnostics h4 {
		margin: 0 0 0.4rem;
	}
	.sender-diagnostics header p,
	.muted {
		color: #66766f;
		margin: 0;
	}
	.sender-diagnostics button {
		font: inherit;
		border: 1px solid #b7c9c0;
		border-radius: 8px;
		background: #f4f8f6;
		color: #18382f;
		padding: 0.55rem 0.75rem;
		cursor: pointer;
	}
	.sender-diagnostics button:disabled {
		opacity: 0.55;
		cursor: wait;
	}
	.checks {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr));
		gap: 0.75rem;
	}
	.checks article {
		border: 1px solid #e2eae6;
		border-radius: 9px;
		padding: 0.85rem;
	}
	.checks dl {
		display: grid;
		grid-template-columns: minmax(7rem, 1fr) 1fr;
		gap: 0.35rem 0.6rem;
		margin: 0;
	}
	.checks dt {
		color: #64756e;
	}
	.checks dd {
		margin: 0;
		font-weight: 600;
		overflow-wrap: anywhere;
	}
	.checks ul {
		padding-left: 1.2rem;
		overflow-wrap: anywhere;
	}
	.notice,
	.error {
		padding: 0.75rem;
		border-radius: 8px;
		margin: 0;
	}
	.notice {
		background: #eef6f1;
		color: #355d4d;
	}
	.error {
		background: #fff1eb;
		color: #8a3425;
	}
	@media (max-width: 650px) {
		.sender-diagnostics header {
			flex-direction: column;
		}
		.checks dl {
			grid-template-columns: 1fr;
		}
	}
</style>
