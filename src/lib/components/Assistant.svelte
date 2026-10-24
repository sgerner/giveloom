<script lang="ts">
	let { tenant = '' }: { tenant?: string } = $props();
	type AssistantSettings = {
		enabled: boolean;
		inputUsdPerMillion: number | null;
		outputUsdPerMillion: number | null;
		requestsPerDay: number;
		tokensPerDay: number;
		costMicroUsdPerDay: number;
		maxOutputTokens: number;
	};
	type Proposal = {
		id: string;
		tool: string;
		title: string;
		summary: string;
		preview: { resource: string; action: string; data: Record<string, unknown> };
		confirmationToken: string;
		expiresAt: string;
	};
	let user = $state<{ role: string } | null>(null);
	let tools = $state<{ name: string; kind: string; description: string }[]>([]);
	let settings = $state<AssistantSettings | null>(null);
	let providerConfigured = $state(false);
	let assistantModel = $state('');
	let modelMatches = $state(true);
	let members = $state<
		{
			userId: string;
			name: string;
			email: string;
			role: string;
			requestsPerDay: number | null;
			tokensPerDay: number | null;
			costMicroUsdPerDay: number | null;
		}[]
	>([]);
	let conversations = $state<
		{
			id: string;
			title: string;
			updatedAt: string;
			messages: { id: string; role: string; content: string; createdAt: string }[];
		}[]
	>([]);
	let conversationId = $state('');
	let transcript = $state<
		{ role: 'user' | 'assistant'; content: string; tools?: unknown[]; proposals?: Proposal[] }[]
	>([]);
	let message = $state('');
	let error = $state('');
	let notice = $state('');
	let busy = $state(false);
	let enabled = $state(false);
	let inputRate = $state('');
	let outputRate = $state('');
	let requestsPerDay = $state('20');
	let tokensPerDay = $state('100000');
	let dailyBudgetUsd = $state('');
	let maxOutputTokens = $state('800');
	let selectedUserId = $state('');
	let userRequestsPerDay = $state('');
	let userTokensPerDay = $state('');
	let userDailyBudgetUsd = $state('');
	let lastUsage = $state<{
		model: string;
		inputTokens: number | null;
		outputTokens: number | null;
		estimatedCostMicroUsd: string;
	} | null>(null);

	async function request(url: string, options?: RequestInit) {
		const response = await fetch(url, options);
		const body = await response.json();
		if (!response.ok) throw new Error(body.error || 'Assistant request failed.');
		return body;
	}
	async function load() {
		error = '';
		try {
			const [session, toolData, settingsData, conversationData] = await Promise.all([
				request('/api/v1/session'),
				request(`/api/v1/ai/tools${tenant ? `?tenant=${encodeURIComponent(tenant)}` : ''}`),
				request('/api/v1/ai/settings'),
				request('/api/v1/ai/conversations')
			]);
			user = session.user;
			tools = toolData.tools || [];
			settings = settingsData.settings;
			providerConfigured = Boolean(settingsData.providerConfigured);
			assistantModel = String(settingsData.model || '');
			modelMatches = Boolean(settingsData.modelMatches);
			members = settingsData.members || [];
			conversations = conversationData.conversations || [];
			if (settings) {
				enabled = settings.enabled;
				inputRate = settings.inputUsdPerMillion == null ? '' : String(settings.inputUsdPerMillion);
				outputRate =
					settings.outputUsdPerMillion == null ? '' : String(settings.outputUsdPerMillion);
				requestsPerDay = String(settings.requestsPerDay);
				tokensPerDay = String(settings.tokensPerDay);
				dailyBudgetUsd = settings.costMicroUsdPerDay
					? String(settings.costMicroUsdPerDay / 1_000_000)
					: '';
				maxOutputTokens = String(settings.maxOutputTokens);
			}
		} catch (e) {
			error = e instanceof Error ? e.message : 'Assistant is unavailable.';
		}
	}
	function startNew() {
		conversationId = '';
		transcript = [];
		lastUsage = null;
		notice = 'New conversation';
	}
	async function openConversation(id: string) {
		busy = true;
		error = '';
		try {
			const result = await request(`/api/v1/ai/conversations/${id}`);
			conversationId = id;
			transcript = (result.conversation.messages || []).map(
				(item: { role: string; content: string }) => ({
					role: item.role === 'user' ? 'user' : 'assistant',
					content: item.content
				})
			);
		} catch (e) {
			error = e instanceof Error ? e.message : 'Could not load conversation.';
		} finally {
			busy = false;
		}
	}
	async function send() {
		if (!message.trim() || busy) return;
		const prompt = message.trim();
		message = '';
		busy = true;
		error = '';
		notice = '';
		transcript = [...transcript, { role: 'user', content: prompt }];
		try {
			const result = await request('/api/v1/ai/execute', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					...(tenant ? { tenant } : {}),
					message: prompt,
					...(conversationId ? { conversationId } : {})
				})
			});
			conversationId = result.conversationId;
			lastUsage = result.usage;
			transcript = [
				...transcript,
				{
					role: 'assistant',
					content: result.answer,
					tools: result.tools || [],
					proposals: result.proposals || []
				}
			];
			await loadConversations();
		} catch (e) {
			error = e instanceof Error ? e.message : 'The assistant could not complete this request.';
			transcript = [
				...transcript,
				{ role: 'assistant', content: 'I could not complete that request. No CRM change was made.' }
			];
		} finally {
			busy = false;
		}
	}
	async function loadConversations() {
		const data = await request('/api/v1/ai/conversations');
		conversations = data.conversations || [];
	}
	async function confirmProposal(proposal: Proposal) {
		if (busy) return;
		busy = true;
		error = '';
		notice = '';
		try {
			const response = await fetch('/api/v1/ai/confirm', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					...(tenant ? { tenant } : {}),
					proposalId: proposal.id,
					confirmationToken: proposal.confirmationToken
				})
			});
			if (!response.ok) {
				const body = await response.json();
				throw new Error(body.error || 'The proposal could not be confirmed.');
			}
			const contentType = response.headers.get('content-type') || '';
			if (contentType.includes('text/csv')) {
				const blob = await response.blob();
				const url = URL.createObjectURL(blob);
				const link = document.createElement('a');
				link.href = url;
				link.download = proposal.title.toLowerCase().includes('export')
					? 'contacts.csv'
					: 'assistant-export.csv';
				link.click();
				URL.revokeObjectURL(url);
				notice = 'Confirmed export downloaded.';
			} else {
				await response.json();
				notice =
					proposal.preview.action === 'create' && proposal.preview.resource === 'emails'
						? 'Draft created. Use the staff email review and approval flow to send it.'
						: 'Confirmed change applied.';
			}
			transcript = transcript.map((entry) => ({
				...entry,
				proposals: entry.proposals?.filter((candidate) => candidate.id !== proposal.id)
			}));
			await load();
		} catch (e) {
			error = e instanceof Error ? e.message : 'The proposal could not be confirmed.';
		} finally {
			busy = false;
		}
	}
	async function saveSettings(event: SubmitEvent) {
		event.preventDefault();
		busy = true;
		error = '';
		notice = '';
		try {
			const result = await request('/api/v1/ai/settings', {
				method: 'PUT',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					enabled,
					inputUsdPerMillion: inputRate === '' ? null : Number(inputRate),
					outputUsdPerMillion: outputRate === '' ? null : Number(outputRate),
					requestsPerDay: Number(requestsPerDay),
					tokensPerDay: Number(tokensPerDay),
					costMicroUsdPerDay: Math.round(Number(dailyBudgetUsd) * 1_000_000),
					maxOutputTokens: Number(maxOutputTokens)
				})
			});
			notice = result.enabled
				? 'AI assistant budgets saved and enabled.'
				: 'AI assistant settings saved.';
			await load();
		} catch (e) {
			error = e instanceof Error ? e.message : 'Settings could not be saved.';
		} finally {
			busy = false;
		}
	}
	async function saveUserLimits(event: SubmitEvent) {
		event.preventDefault();
		if (!selectedUserId) return;
		busy = true;
		error = '';
		notice = '';
		try {
			await request('/api/v1/ai/settings', {
				method: 'PATCH',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					userId: selectedUserId,
					requestsPerDay: Number(userRequestsPerDay),
					tokensPerDay: Number(userTokensPerDay),
					costMicroUsdPerDay: Math.round(Number(userDailyBudgetUsd) * 1_000_000)
				})
			});
			notice = 'User AI budget saved.';
			await load();
		} catch (e) {
			error = e instanceof Error ? e.message : 'User AI budget could not be saved.';
		} finally {
			busy = false;
		}
	}
	function usd(micro: string | number) {
		return (Number(micro) / 1_000_000).toFixed(4);
	}
	$effect(() => {
		void load();
	});
</script>

<section class="assistant" aria-labelledby="assistant-title">
	<header class="assistant-head">
		<div>
			<p class="eyebrow">Workspace copilot</p>
			<h2 id="assistant-title">CRM assistant</h2>
			<p>
				Ask about your contacts, giving, campaigns, prospects, segments, reports, and tasks. Reads
				stay inside this workspace.
			</p>
		</div>
		<button class="new" type="button" onclick={startNew}>New conversation</button>
	</header>
	<details class="tool-catalog">
		<summary>Available tools</summary>
		<div>
			{#each tools as tool (tool.name)}<article>
					<strong>{tool.name.replaceAll('_', ' ')}</strong><span
						>{tool.kind.replaceAll('_', ' ')}</span
					>
					<p>{tool.description}</p>
				</article>{/each}
		</div>
		<p class="hint">
			The assistant can draft and preview CRM changes. Email delivery still requires the existing
			recipient review and approval process.
		</p>
	</details>
	{#if error}<p class="alert" role="alert">{error}</p>{/if}
	{#if notice}<p class="notice" role="status">{notice}</p>{/if}
	{#if user && ['owner', 'admin'].includes(user.role)}
		<details class="settings" open={!settings?.enabled || !providerConfigured}>
			<summary>AI provider and budget settings</summary>
			{#if !providerConfigured}<p>
					Connect an OpenAI API key in Integrations before enabling assistant requests. The key
					remains encrypted in the server.
				</p>{/if}
			{#if settings?.enabled && !modelMatches}<p class="alert">
					The configured OpenAI model changed. Update pricing for the current model and save before
					making further requests.
				</p>{/if}
			<form onsubmit={saveSettings}>
				<label class="toggle"
					><input type="checkbox" bind:checked={enabled} /> Enable assistant for this tenant</label
				>
				{#if assistantModel}<p class="model-label">
						Configured model: <strong>{assistantModel}</strong>
					</p>{/if}
				<div class="settings-grid">
					<label
						>Input USD per 1M tokens<input
							type="number"
							min="0"
							step="0.000001"
							bind:value={inputRate}
							placeholder="Enter your configured rate"
							required={enabled}
						/></label
					>
					<label
						>Output USD per 1M tokens<input
							type="number"
							min="0"
							step="0.000001"
							bind:value={outputRate}
							placeholder="Enter your configured rate"
							required={enabled}
						/></label
					>
					<label
						>Tenant requests per day<input
							type="number"
							min="1"
							max="10000"
							bind:value={requestsPerDay}
							required
						/></label
					>
					<label
						>Tenant tokens per day<input
							type="number"
							min="1"
							max="10000000"
							bind:value={tokensPerDay}
							required
						/></label
					>
					<label
						>Tenant dollar cap per day<input
							type="number"
							min="0"
							step="0.01"
							bind:value={dailyBudgetUsd}
							placeholder="Enter a hard daily cap"
							required={enabled}
						/></label
					>
					<label
						>Max output tokens<input
							type="number"
							min="64"
							max="4000"
							bind:value={maxOutputTokens}
							required
						/></label
					>
				</div>
				<p class="hint">
					Rates are entered from your provider billing agreement. Giveloom supplies no assumed
					prices. Each request reserves the configured input and maximum-output cost before
					contacting the provider.
				</p>
				<button class="primary" disabled={busy}>Save limits</button>
			</form>
			{#if members.length}<form class="user-budget" onsubmit={saveUserLimits}>
					<h3>Per-user daily override</h3>
					<div class="settings-grid">
						<label
							>Staff member<select
								bind:value={selectedUserId}
								onchange={() => {
									const member = members.find((candidate) => candidate.userId === selectedUserId);
									userRequestsPerDay = String(member?.requestsPerDay ?? requestsPerDay);
									userTokensPerDay = String(member?.tokensPerDay ?? tokensPerDay);
									userDailyBudgetUsd =
										member?.costMicroUsdPerDay == null
											? dailyBudgetUsd
											: String(member.costMicroUsdPerDay / 1_000_000);
								}}
								required
								><option value="">Choose a member</option
								>{#each members as member (member.userId)}<option value={member.userId}
										>{member.name} · {member.role}</option
									>{/each}</select
							></label
						><label
							>Requests per day<input
								type="number"
								min="1"
								max="10000"
								bind:value={userRequestsPerDay}
								required
							/></label
						><label
							>Tokens per day<input
								type="number"
								min="1"
								max="10000000"
								bind:value={userTokensPerDay}
								required
							/></label
						><label
							>Dollar cap per day<input
								type="number"
								min="0"
								step="0.01"
								bind:value={userDailyBudgetUsd}
								required
							/></label
						>
					</div>
					<button class="new" disabled={busy || !selectedUserId}>Save member override</button>
					<p class="hint">A member without an override uses the tenant limits above.</p>
				</form>{/if}
		</details>
	{/if}
	<div class="layout">
		<aside class="history" aria-label="Conversation history">
			<h3>Recent conversations</h3>
			{#if conversations.length}{#each conversations as conversation (conversation.id)}<button
						class:active={conversation.id === conversationId}
						type="button"
						onclick={() => openConversation(conversation.id)}
						><strong>{conversation.title}</strong><span
							>{new Date(conversation.updatedAt).toLocaleDateString()}</span
						></button
					>{/each}{:else}<p>No saved conversations yet.</p>{/if}
			<p class="retention">
				Stored prompts are redacted; audit hashes and redacted transcripts expire after 30 days.
			</p>
		</aside>
		<div class="chat">
			<div class="messages" aria-live="polite">
				{#if !transcript.length}<div class="welcome">
						<span>✦</span>
						<h3>What would you like to understand?</h3>
						<p>
							Try “Summarize open tasks for the lapsed donor segment” or “Compare giving by campaign
							over the last month.”
						</p>
					</div>{/if}
				{#each transcript as entry, index (`${index}-${entry.role}-${entry.content.slice(0, 24)}`)}
					<article class:human={entry.role === 'user'} class="message">
						<span class="speaker">{entry.role === 'user' ? 'You' : 'Assistant'}</span>
						<p>{entry.content}</p>
						{#if entry.tools?.length}<div class="tool-results">
								<h4>CRM results</h4>
								{#each entry.tools as tool}<details>
										<summary
											>{String(
												(tool as { tool?: string }).tool || 'Read tool'
											)}{#if (tool as { records?: unknown[] }).records}
												· {(tool as { records: unknown[] }).records.length} records{/if}</summary
										>
										<pre>{JSON.stringify(tool, null, 2)}</pre>
									</details>{/each}
							</div>{/if}
						{#if entry.proposals?.length}{#each entry.proposals as proposal (proposal.id)}<section
									class="proposal"
								>
									<div>
										<span class="eyebrow">Review before change</span>
										<h4>{proposal.title}</h4>
										<p>{proposal.summary}</p>
									</div>
									<dl>
										<dt>Action</dt>
										<dd>{proposal.preview.action} · {proposal.preview.resource}</dd>
										<dt>Exact preview</dt>
										<dd><pre>{JSON.stringify(proposal.preview.data, null, 2)}</pre></dd>
										<dt>Expires</dt>
										<dd>{new Date(proposal.expiresAt).toLocaleTimeString()}</dd>
									</dl>
									<button
										class="primary"
										type="button"
										disabled={busy}
										onclick={() => confirmProposal(proposal)}>Confirm this exact change</button
									>
									<p class="hint">
										No email is sent. Gift entries are immutable and require finance permission.
									</p>
								</section>{/each}{/if}
					</article>
				{/each}
				{#if busy}<p class="thinking" role="status">Checking your CRM workspace…</p>{/if}
			</div>
			<form
				class="composer"
				onsubmit={(event) => {
					event.preventDefault();
					void send();
				}}
			>
				<label for="assistant-message">Message</label><textarea
					id="assistant-message"
					bind:value={message}
					rows="3"
					maxlength="2000"
					placeholder="Ask a question about your CRM…"
					disabled={busy || !settings?.enabled || !modelMatches}></textarea>
				<div>
					<small
						>{#if lastUsage}Model {lastUsage.model} · {lastUsage.inputTokens ?? '—'} input / {lastUsage.outputTokens ??
								'—'} output tokens · reserved up to ${usd(
								lastUsage.estimatedCostMicroUsd
							)}{:else}Changes require a separate, one-use confirmation.{/if}</small
					><button
						class="primary"
						disabled={busy || !message.trim() || !settings?.enabled || !modelMatches}
						>{busy ? 'Working…' : 'Ask assistant'}</button
					>
				</div>
			</form>
		</div>
	</div>
	{#if !settings?.enabled}<p class="setup-note">
			Assistant requests are disabled until an owner or administrator configures the provider and
			budgets.
		</p>{/if}
</section>

<style>
	.assistant {
		--ink: #173631;
		--muted: #657773;
		--line: #dbe6e1;
		--surface: #fff;
		color: var(--ink);
		background: var(--surface);
		border: 1px solid var(--line);
		border-radius: 18px;
		padding: 1.2rem;
		box-shadow: 0 14px 38px #1736310a;
	}
	.assistant-head {
		display: flex;
		justify-content: space-between;
		align-items: flex-start;
		gap: 1rem;
		margin-bottom: 1rem;
	}
	.assistant h2 {
		margin: 0.2rem 0;
		font-size: 1.5rem;
	}
	.assistant p {
		color: var(--muted);
		line-height: 1.5;
	}
	.eyebrow {
		text-transform: uppercase;
		letter-spacing: 0.1em;
		font-size: 0.72rem;
		font-weight: 700;
		color: #397d69;
		margin: 0;
	}
	.new,
	.primary {
		border: 0;
		border-radius: 9px;
		padding: 0.65rem 0.9rem;
		font: inherit;
		font-weight: 650;
		cursor: pointer;
	}
	.new {
		background: #edf5f1;
		color: #285b4d;
	}
	.primary {
		background: #146b55;
		color: white;
	}
	.primary:disabled,
	.new:disabled {
		opacity: 0.55;
		cursor: wait;
	}
	.alert,
	.notice {
		padding: 0.65rem 0.8rem;
		border-radius: 8px;
	}
	.alert {
		background: #fff0ee;
		color: #9a302b;
	}
	.notice {
		background: #ebf7ef;
		color: #266445;
	}
	.settings,
	.tool-catalog {
		border: 1px solid var(--line);
		border-radius: 12px;
		padding: 0.85rem;
		margin: 1rem 0;
	}
	.settings summary,
	.tool-catalog summary {
		font-weight: 700;
		cursor: pointer;
	}
	.settings form {
		margin-top: 0.8rem;
	}
	.tool-catalog > div {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 0.55rem;
		margin: 0.8rem 0;
	}
	.tool-catalog article {
		border: 1px solid var(--line);
		border-radius: 8px;
		padding: 0.6rem;
	}
	.tool-catalog article strong,
	.tool-catalog article span {
		display: block;
	}
	.tool-catalog article span {
		color: #397d69;
		font-size: 0.74rem;
		text-transform: capitalize;
	}
	.tool-catalog article p {
		font-size: 0.8rem;
		margin: 0.3rem 0;
	}
	.settings-grid {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 0.7rem;
	}
	.assistant label {
		display: grid;
		gap: 0.35rem;
		font-size: 0.86rem;
		font-weight: 600;
	}
	.assistant input:not([type='checkbox']),
	.assistant textarea {
		width: 100%;
		font: inherit;
		border: 1px solid #cbd9d3;
		border-radius: 8px;
		padding: 0.6rem;
		background: white;
		color: var(--ink);
	}
	.toggle {
		display: flex !important;
		align-items: center;
		gap: 0.5rem;
		margin: 0.5rem 0;
	}
	.hint,
	.retention {
		font-size: 0.8rem;
	}
	.layout {
		display: grid;
		grid-template-columns: minmax(190px, 235px) minmax(0, 1fr);
		gap: 1rem;
	}
	.history {
		border-right: 1px solid var(--line);
		padding-right: 0.75rem;
	}
	.history h3 {
		font-size: 0.9rem;
		margin: 0.3rem 0 0.7rem;
	}
	.history button {
		display: grid;
		width: 100%;
		gap: 0.2rem;
		text-align: left;
		border: 1px solid transparent;
		border-radius: 8px;
		background: transparent;
		padding: 0.55rem;
		color: var(--ink);
		cursor: pointer;
	}
	.history button.active,
	.history button:hover {
		background: #f1f6f3;
		border-color: #d6e3dd;
	}
	.history button strong {
		font-size: 0.85rem;
	}
	.history button span {
		font-size: 0.75rem;
		color: var(--muted);
	}
	.retention {
		margin-top: 1.2rem;
	}
	.chat {
		min-width: 0;
	}
	.messages {
		display: grid;
		gap: 0.8rem;
		max-height: 640px;
		overflow: auto;
		padding: 0.2rem 0.2rem 1rem;
	}
	.welcome {
		text-align: center;
		padding: 4rem 1rem 3rem;
	}
	.welcome > span {
		font-size: 2rem;
		color: #37816c;
	}
	.welcome h3 {
		margin: 0.4rem 0;
	}
	.message {
		border: 1px solid var(--line);
		border-radius: 12px;
		padding: 0.85rem;
	}
	.message.human {
		background: #f5f8f6;
	}
	.speaker {
		font-size: 0.75rem;
		font-weight: 700;
		color: #38705f;
	}
	.message p {
		white-space: pre-wrap;
		margin: 0.4rem 0;
	}
	.tool-results,
	.proposal {
		margin-top: 0.8rem;
		border-top: 1px solid var(--line);
		padding-top: 0.7rem;
	}
	.tool-results h4,
	.proposal h4 {
		margin: 0.25rem 0;
	}
	.tool-results details {
		border: 1px solid var(--line);
		border-radius: 8px;
		padding: 0.5rem;
		margin: 0.4rem 0;
	}
	.tool-results summary {
		cursor: pointer;
		font-weight: 600;
	}
	.tool-results pre,
	.proposal pre {
		white-space: pre-wrap;
		overflow-wrap: anywhere;
		max-height: 220px;
		overflow: auto;
		background: #f5f8f6;
		padding: 0.55rem;
		border-radius: 7px;
		font-size: 0.75rem;
	}
	.proposal {
		background: #fbfcfb;
		padding: 0.9rem;
		border: 1px solid #d7e4dd;
		border-radius: 10px;
	}
	.proposal dl {
		display: grid;
		grid-template-columns: 120px 1fr;
		gap: 0.3rem;
		font-size: 0.83rem;
	}
	.proposal dt {
		font-weight: 700;
	}
	.proposal dd {
		margin: 0;
	}
	.proposal button {
		margin-top: 0.3rem;
	}
	.composer {
		border-top: 1px solid var(--line);
		padding-top: 0.8rem;
	}
	.composer textarea {
		resize: vertical;
	}
	.composer > div {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		margin-top: 0.6rem;
	}
	.composer small {
		color: var(--muted);
	}
	.thinking {
		font-size: 0.88rem;
	}
	.setup-note {
		font-size: 0.85rem;
	}
	@media (max-width: 760px) {
		.layout {
			grid-template-columns: 1fr;
		}
		.history {
			border-right: 0;
			border-bottom: 1px solid var(--line);
			padding: 0 0 0.7rem;
			max-height: 170px;
			overflow: auto;
		}
		.settings-grid,
		.tool-catalog > div {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
		.assistant-head {
			flex-direction: column;
		}
	}
	@media (max-width: 480px) {
		.settings-grid,
		.tool-catalog > div {
			grid-template-columns: 1fr;
		}
		.composer > div {
			align-items: stretch;
			flex-direction: column;
		}
	}
</style>
