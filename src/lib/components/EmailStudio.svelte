<script lang="ts">
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	type Block = { type: 'heading' | 'paragraph' | 'button'; text: string; url?: string };
	let {
		emailId = '',
		tenant,
		demo = false,
		onChanged = () => {}
	} = $props<{ emailId?: string; tenant: string; demo?: boolean; onChanged?: () => void }>();
	let selectedId = $state(''),
		drafts = $state<any[]>([]),
		nextDraftCursor = $state<string | null>(null),
		loadingMoreDrafts = $state(false),
		ready = $state(false),
		draft = $state<any>({ subject: '', body: '', htmlBody: '', preheader: '', status: 'draft' }),
		workspace = $state<any>({ segments: [], user: null }),
		templates = $state<any[]>([]),
		batches = $state<any[]>([]),
		blocks = $state<Block[]>([
			{ type: 'heading', text: '' },
			{ type: 'paragraph', text: '' }
		]),
		sourceMode = $state(false),
		preview = $state<any>(null),
		segmentId = $state(''),
		scheduledLocal = $state(''),
		busy = $state(false),
		error = $state(''),
		notice = $state(''),
		approved = $state(false),
		testApproved = $state(false);
	const esc = (value: string) =>
		value.replace(
			/[&<>"']/g,
			(c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!
		);
	function blocksHtml() {
		return blocks
			.map((b) =>
				b.type === 'heading'
					? `<h1>${esc(b.text)}</h1>`
					: b.type === 'button'
						? `<p><a href="${esc(b.url || '#')}">${esc(b.text)}</a></p>`
						: `<p>${esc(b.text).replaceAll('\n', '<br>')}</p>`
			)
			.join('\n');
	}
	function tenantLocalToIso(value: string, timeZone: string) {
		const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
		if (!match) throw new Error('Choose a valid scheduled date and time.');
		const target = Date.UTC(
			Number(match[1]),
			Number(match[2]) - 1,
			Number(match[3]),
			Number(match[4]),
			Number(match[5])
		);
		let guess = target;
		const format = new Intl.DateTimeFormat('en-US', {
			timeZone,
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
			hour: '2-digit',
			minute: '2-digit',
			hourCycle: 'h23'
		});
		for (let i = 0; i < 4; i++) {
			const parts = Object.fromEntries(
				format.formatToParts(new Date(guess)).map((part) => [part.type, part.value])
			);
			const seen = Date.UTC(
				Number(parts.year),
				Number(parts.month) - 1,
				Number(parts.day),
				Number(parts.hour),
				Number(parts.minute)
			);
			const offset = target - seen;
			if (!offset) break;
			guess += offset;
		}
		const final = Object.fromEntries(
			format.formatToParts(new Date(guess)).map((part) => [part.type, part.value])
		);
		if (
			Number(final.year) !== Number(match[1]) ||
			Number(final.month) !== Number(match[2]) ||
			Number(final.day) !== Number(match[3]) ||
			Number(final.hour) !== Number(match[4]) ||
			Number(final.minute) !== Number(match[5])
		)
			throw new Error(
				'That local time does not exist in the tenant time zone because of a clock change. Choose another time.'
			);
		return new Date(guess).toISOString();
	}
	function previewMarkup() {
		return (sourceMode ? String(draft.htmlBody || '') : blocksHtml())
			.replace(
				/<(script|style|iframe|object|embed|svg|math|form|input|button|link|meta|base|img|video|audio|source)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,
				''
			)
			.replace(
				/<(script|style|iframe|object|embed|svg|math|form|input|button|link|meta|base|img|video|audio|source)\b[^>]*\/?\s*>/gi,
				''
			)
			.replace(/\s(?:src|srcset|on[a-z]+)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
			.replace(/url\s*\([^)]*\)/gi, '');
	}
	function textFromHtml(html: string) {
		return html
			.replace(/<br\s*\/?\s*>/gi, '\n')
			.replace(/<\/(p|h[1-6]|div|li)\s*>/gi, '\n')
			.replace(/<[^>]*>/g, '')
			.replace(/&amp;/g, '&')
			.replace(/&lt;/g, '<')
			.replace(/&gt;/g, '>')
			.replace(/&quot;/g, '"')
			.replace(/&#39;/g, "'")
			.trim();
	}
	async function request(url: string, method = 'GET', body?: unknown) {
		const response = await fetch(url, {
			method,
			headers: body ? { 'content-type': 'application/json' } : undefined,
			body: body ? JSON.stringify(body) : undefined
		});
		const result = await response.json();
		if (!response.ok) throw new Error(result.error || 'The request could not be completed.');
		return result;
	}
	function editorPath(id = '') {
		return `/app/${encodeURIComponent(tenant)}/email${id ? `/${encodeURIComponent(id)}` : ''}`;
	}
	async function loadDraftPage(cursor?: string | null, append = false) {
		const params = new URLSearchParams({ limit: '50' });
		if (cursor) params.set('cursor', cursor);
		const result = await request(`/api/v1/email?${params}`);
		drafts = append ? [...drafts, ...(result.emails || [])] : result.emails || [];
		nextDraftCursor = result.nextCursor || null;
		templates = result.templates || [];
		batches = result.batches || [];
	}
	async function load() {
		busy = true;
		ready = false;
		error = '';
		try {
			const [w] = await Promise.all([
				request(`/api/v1/workspace?tenant=${encodeURIComponent(tenant)}&compact=true`),
				loadDraftPage()
			]);
			workspace = w;
			if (demo) drafts = w.emails || [];
			if (selectedId) {
				const found = demo
					? w.emails?.find((item: any) => item.id === selectedId)
					: (await request(`/api/v1/email?id=${encodeURIComponent(selectedId)}`)).draft;
				if (!found) throw new Error('Email draft not found.');
				draft = { ...found, htmlBody: found.htmlBody || '' };
				if (!drafts.some((item) => item.id === selectedId)) {
					drafts = [
						{
							id: selectedId,
							subject: found.subject || found.name || 'Untitled draft',
							status: found.status
						},
						...drafts
					];
				}
				segmentId = found.segmentId || '';
				blocks = [{ type: 'paragraph', text: textFromHtml(found.htmlBody || found.body || '') }];
				sourceMode = Boolean(found.htmlBody);
				if (found.htmlBody) {
					blocks = [{ type: 'paragraph', text: textFromHtml(found.htmlBody) }];
				}
			} else {
				selectedId = '';
				resetDraft();
			}
		} catch (e) {
			error = e instanceof Error ? e.message : 'Email workspace unavailable.';
		} finally {
			ready = true;
			busy = false;
		}
	}
	function resetDraft() {
		draft = { subject: '', body: '', htmlBody: '', preheader: '', status: 'draft' };
		blocks = [
			{ type: 'heading', text: '' },
			{ type: 'paragraph', text: '' }
		];
		sourceMode = false;
		segmentId = '';
		scheduledLocal = '';
		preview = null;
	}
	async function openDraft(id: string) {
		if (!id) {
			selectedId = '';
			resetDraft();
			await goto(editorPath(), { replaceState: true, keepFocus: true, noScroll: true });
			return;
		}
		busy = true;
		ready = false;
		error = '';
		try {
			const found = demo
				? workspace.emails?.find((item: any) => item.id === id)
				: (await request(`/api/v1/email?id=${encodeURIComponent(id)}`)).draft;
			if (!found) throw new Error('Email draft not found.');
			selectedId = id;
			draft = { ...found, htmlBody: found.htmlBody || '' };
			if (!drafts.some((item) => item.id === id)) {
				drafts = [
					{ id, subject: found.subject || found.name || 'Untitled draft', status: found.status },
					...drafts
				];
			}
			segmentId = found.segmentId || '';
			scheduledLocal = '';
			preview = null;
			if (found.htmlBody) {
				blocks = [{ type: 'paragraph', text: textFromHtml(found.htmlBody) }];
				sourceMode = true;
			} else {
				blocks = [
					{ type: 'heading', text: '' },
					{ type: 'paragraph', text: found.body || '' }
				];
				sourceMode = false;
			}
			await goto(editorPath(id), { replaceState: true, keepFocus: true, noScroll: true });
		} catch (e) {
			error = e instanceof Error ? e.message : 'Email draft could not be opened.';
		} finally {
			ready = true;
			busy = false;
		}
	}
	async function loadMoreDrafts() {
		if (!nextDraftCursor || loadingMoreDrafts) return;
		loadingMoreDrafts = true;
		try {
			await loadDraftPage(nextDraftCursor, true);
		} catch (e) {
			error = e instanceof Error ? e.message : 'More drafts could not be loaded.';
		} finally {
			loadingMoreDrafts = false;
		}
	}
	async function save() {
		busy = true;
		error = '';
		notice = '';
		try {
			if (!sourceMode) draft.htmlBody = blocksHtml();
			draft.body = draft.body?.trim() || textFromHtml(draft.htmlBody);
			const data = {
				subject: draft.subject,
				body: draft.body,
				htmlBody: draft.htmlBody,
				preheader: draft.preheader,
				status: draft.status || 'draft',
				contactId: draft.contactId || undefined,
				segmentId: segmentId || null,
				templateId: draft.templateId || undefined,
				consent: draft.consent
			};
			const result = await request('/api/v1/workspace', 'POST', {
				tenant,
				resource: 'emails',
				action: selectedId ? 'update' : 'create',
				data: selectedId ? { ...data, id: selectedId } : data
			});
			draft = { ...result.item };
			selectedId = draft.id;
			drafts = [
				{
					id: draft.id,
					subject: draft.subject || draft.name || 'Untitled draft',
					status: draft.status
				},
				...drafts.filter((item) => item.id !== draft.id)
			];
			notice = 'Draft saved.';
			onChanged();
			return true;
		} catch (e) {
			error = e instanceof Error ? e.message : 'Draft could not be saved.';
			return false;
		} finally {
			busy = false;
		}
	}
	function addBlock(type: Block['type']) {
		blocks = [
			...blocks,
			{
				type,
				text: type === 'heading' ? 'A thoughtful headline' : '',
				...(type === 'button' ? { url: '' } : {})
			}
		];
	}
	function move(index: number, delta: number) {
		const target = index + delta;
		if (target < 0 || target >= blocks.length) return;
		const next = [...blocks];
		[next[index], next[target]] = [next[target]!, next[index]!];
		blocks = next;
	}
	function parseBlocks() {
		const source = draft.htmlBody || '';
		const matches = [...source.matchAll(/<(h1|h2|h3|p)\b[^>]*>([\s\S]*?)<\/(?:h1|h2|h3|p)>/gi)];
		blocks = matches.length
			? matches.map(
					(match) =>
						({
							type: /^h/i.test(match[1]!) ? 'heading' : 'paragraph',
							text: textFromHtml(match[2]!),
							url: ''
						}) as Block
				)
			: [{ type: 'paragraph', text: textFromHtml(source) }];
		sourceMode = false;
	}
	async function previewSend() {
		if (!(await save())) return;
		busy = true;
		error = '';
		try {
			const timezone = workspace.tenant?.timeZone || 'UTC';
			const scheduledAt = scheduledLocal ? tenantLocalToIso(scheduledLocal, timezone) : null;
			const result = await request('/api/v1/email/preview', 'POST', {
				emailId: draft.id,
				segmentId: segmentId || null,
				scheduledAt
			});
			preview = result;
			approved = false;
		} catch (e) {
			error = e instanceof Error ? e.message : 'Recipient preview failed.';
		} finally {
			busy = false;
		}
	}
	async function approveSend() {
		if (!preview || !approved) return;
		busy = true;
		error = '';
		try {
			const result = await request('/api/v1/email/send', 'POST', {
				previewToken: preview.previewToken,
				approved: true
			});
			notice =
				result.status === 'scheduled'
					? `Scheduled for ${new Date(result.scheduledAt).toLocaleString()} (${result.timeZone}).`
					: `${result.queued} recipient message(s) queued.`;
			preview = null;
			await load();
			onChanged();
		} catch (e) {
			error = e instanceof Error ? e.message : 'Email was not queued.';
		} finally {
			busy = false;
		}
	}
	async function sendTest() {
		if (!testApproved) return;
		if (!(await save())) return;
		busy = true;
		error = '';
		try {
			const result = await request('/api/v1/email/test-send', 'POST', {
				emailId: draft.id,
				approved: true
			});
			notice =
				result.status === 'uncertain'
					? 'The provider outcome is uncertain; automatic resend is blocked. Check delivery before trying again.'
					: 'A test was accepted for your signed-in account email.';
			testApproved = false;
		} catch (e) {
			error = e instanceof Error ? e.message : 'Test message was not sent.';
		} finally {
			busy = false;
		}
	}
	async function saveTemplate() {
		busy = true;
		try {
			if (!sourceMode) draft.htmlBody = blocksHtml();
			const result = await request('/api/v1/email/templates', 'POST', {
				name: `Template ${new Date().toLocaleDateString()}`,
				subject: draft.subject || 'A note from our organization',
				htmlBody: draft.htmlBody,
				textBody: draft.body || textFromHtml(draft.htmlBody)
			});
			templates = [result, ...templates];
			notice = 'Reusable template saved.';
		} catch (e) {
			error = e instanceof Error ? e.message : 'Template could not be saved.';
		} finally {
			busy = false;
		}
	}
	function applyTemplate(id: string) {
		const template = templates.find((item) => item.id === id);
		if (!template) return;
		draft = {
			...draft,
			subject: template.subject,
			body: template.textBody,
			htmlBody: template.htmlBody,
			templateId: template.id
		};
		parseBlocks();
	}
	onMount(() => {
		selectedId = emailId;
		void load();
	});
</script>

<section class="studio" aria-labelledby="email-studio-title">
	<header>
		<span class="eyebrow">CONSENT-AWARE OUTREACH</span>
		<h2 id="email-studio-title">Email studio</h2>
		<p>
			Build a message, preview the exact eligible recipients, then approve a queued or scheduled
			send.
		</p>
	</header>
	{#if error}<p class="alert" role="alert">{error}</p>{/if}{#if notice}<p
			class="notice"
			role="status"
		>
			{notice}
		</p>{/if}
	{#if demo}<p class="alert">
			Demo email stays synthetic. Live recipients and provider sends are disabled.
		</p>{/if}
	<div class="draft-controls" aria-label="Saved email drafts">
		<label
			>Saved drafts<select
				value={selectedId}
				disabled={!ready || busy}
				onchange={(event) => void openDraft(event.currentTarget.value)}
			>
				<option value="">New draft</option>
				{#each drafts as item (item.id)}<option value={item.id}
						>{item.subject || item.id} · {item.status || 'draft'}</option
					>{/each}
			</select></label
		><button
			type="button"
			onclick={() => void openDraft('')}
			disabled={!ready || !selectedId || busy}>New draft</button
		>{#if nextDraftCursor}<button
				type="button"
				onclick={loadMoreDrafts}
				disabled={!ready || loadingMoreDrafts || busy}
				>{loadingMoreDrafts ? 'Loading…' : 'Load more drafts'}</button
			>{/if}
	</div>
	<div class="grid">
		<section class="editor" aria-label="Email editor">
			<fieldset class="editor-fields" disabled={!ready || busy}>
				<label>Subject<input maxlength="300" bind:value={draft.subject} required /></label><label
					>Inbox preheader<input
						maxlength="180"
						bind:value={draft.preheader}
						placeholder="A little context for the inbox"
					/></label
				>
				<div class="field-row">
					<label
						>Recipient segment<select bind:value={segmentId}
							><option value="">All consented contacts</option
							>{#each workspace.segments || [] as segment}<option value={segment.id}
									>{segment.name}</option
								>{/each}</select
						></label
					><label
						>Schedule in tenant time<input
							type="datetime-local"
							bind:value={scheduledLocal}
						/><small
							>{workspace.tenant?.timeZone || 'Tenant time zone'}; leave empty to queue now.</small
						></label
					>
				</div>
				<div class="toolbar" aria-label="Email block tools">
					<button type="button" onclick={() => addBlock('heading')}>Add heading</button><button
						type="button"
						onclick={() => addBlock('paragraph')}>Add paragraph</button
					><button type="button" onclick={() => addBlock('button')}>Add link</button><button
						type="button"
						onclick={() => {
							sourceMode = !sourceMode;
						}}
					>
						{sourceMode ? 'Edit blocks' : 'Edit HTML source'}</button
					>{#if sourceMode}<button type="button" onclick={parseBlocks}
							>Convert source to blocks</button
						>{/if}
				</div>
				{#if sourceMode}<label
						>HTML source<textarea
							rows="14"
							bind:value={draft.htmlBody}
							spellcheck="false"
							aria-describedby="source-help"></textarea><small id="source-help"
							>Server saves only the safe email HTML allowlist. Script, form, and unsafe links are
							removed.</small
						></label
					>{:else}<div class="blocks" aria-label="Message blocks">
						{#each blocks as block, index}<fieldset>
								<legend
									>{block.type === 'heading'
										? 'Heading'
										: block.type === 'button'
											? 'Link'
											: 'Paragraph'}
									{index + 1}</legend
								><label
									>{block.type === 'button' ? 'Link text' : 'Text'}<textarea
										rows={block.type === 'paragraph' ? 4 : 2}
										bind:value={block.text}></textarea></label
								>{#if block.type === 'button'}<label
										>Destination URL<input
											type="url"
											bind:value={block.url}
											placeholder="https://example.org"
										/></label
									>{/if}
								<div class="move">
									<button
										type="button"
										aria-label={`Move block ${index + 1} up`}
										disabled={!index}
										onclick={() => move(index, -1)}>Move up</button
									><button
										type="button"
										aria-label={`Move block ${index + 1} down`}
										disabled={index === blocks.length - 1}
										onclick={() => move(index, 1)}>Move down</button
									><button
										type="button"
										aria-label={`Remove block ${index + 1}`}
										onclick={() => (blocks = blocks.filter((_, i) => i !== index))}>Remove</button
									>
								</div>
							</fieldset>{/each}
					</div>{/if}
				<label
					>Plain-text fallback<textarea
						rows="8"
						bind:value={draft.body}
						placeholder="A readable version for email clients that do not display HTML"
					></textarea></label
				>
				<p class="muted">
					Personalization: <code>&#123;&#123;name&#125;&#125;</code>,
					<code>&#123;&#123;preferredName&#125;&#125;</code>,
					<code>&#123;&#123;email&#125;&#125;</code>. Missing preferred names fall back to the
					contact’s first name.
				</p>
				<div class="toolbar">
					<button type="button" disabled={busy || !draft.subject?.trim()} onclick={save}
						>{busy ? 'Saving…' : 'Save draft'}</button
					><button
						type="button"
						disabled={busy || !draft.subject?.trim() || demo}
						onclick={previewSend}>Review recipients</button
					><button type="button" disabled={busy || demo} onclick={saveTemplate}
						>Save reusable template</button
					>
				</div>
				<div class="test-send">
					<label
						><input type="checkbox" bind:checked={testApproved} disabled={demo || busy} /> Send one
						test to my signed-in account email ({workspace.user?.email || 'unavailable'}). This does
						not contact the marketing audience.</label
					><button
						type="button"
						disabled={!testApproved || busy || demo || !selectedId}
						onclick={sendTest}>Send test message</button
					>
				</div>
				<label
					>Apply a saved template<select
						value=""
						onchange={(event) => applyTemplate(event.currentTarget.value)}
						><option value="">Choose template</option>{#each templates as template}<option
								value={template.id}>{template.name}</option
							>{/each}</select
					></label
				>
			</fieldset>
		</section>
		<aside class="preview">
			<h3>Message preview</h3>
			<p class="muted">
				The HTML view is sandboxed; final delivery adds unsubscribe and preference links.
			</p>
			<iframe
				title="Sanitized email HTML preview"
				sandbox=""
				srcdoc={`<!doctype html><meta charset="utf-8"><main style="font:16px system-ui;padding:1rem">${previewMarkup()}<hr><p>You are receiving this because you asked for updates. <a href="#">Unsubscribe</a> · <a href="#">Manage preferences</a></p></main>`}
			></iframe>
			<h4>Plain-text fallback</h4>
			<pre>{(draft.body || textFromHtml(draft.htmlBody || blocksHtml()))
					.replaceAll('{{name}}', 'Friend')
					.replaceAll('{{preferredName}}', 'Friend')
					.replaceAll('{{email}}', 'friend@example.org')}</pre>
		</aside>
	</div>
	{#if preview}<section class="approval" aria-labelledby="preview-heading">
			<h3 id="preview-heading">Review before approval</h3>
			<p>
				{preview.count} exact recipient(s) · From {preview.from} · {preview.sandboxMode
					? 'SES sandbox: only individually verified recipients are included.'
					: 'SES production sending access verified.'}
			</p>
			<p>
				Quota: {preview.quota?.remaining24Hour} remaining today, {preview.quota
					?.maxSendRate}/second. Estimated cost: {preview.estimatedCost
					? `$${preview.estimatedCost.totalUsd.toFixed(4)} USD`
					: 'not configured'}.
			</p>
			{#if preview.sandboxExcludedCount}<p>
					{preview.sandboxExcludedCount} recipient(s) excluded because their address is not SES-verified.
				</p>{/if}{#if preview.scheduledAt}<p>
					Scheduled for {new Intl.DateTimeFormat(undefined, {
						timeZone: preview.timeZone,
						dateStyle: 'medium',
						timeStyle: 'short'
					}).format(new Date(preview.scheduledAt))} in {preview.timeZone}.
				</p>{/if}
			<ul>
				{#each preview.recipients as recipient}<li>{recipient.name} · {recipient.email}</li>{/each}
			</ul>
			<label class="confirm"
				><input type="checkbox" bind:checked={approved} /> I reviewed this exact recipient list and
				approve {preview.scheduledAt ? 'scheduling' : 'queueing'} the message.</label
			>
			<div class="toolbar">
				<button type="button" onclick={() => (preview = null)}>Cancel</button><button
					type="button"
					disabled={!approved || !preview.withinQuota || busy}
					onclick={approveSend}
					>{preview.scheduledAt ? 'Approve scheduled send' : 'Approve and queue'}</button
				>
			</div>
		</section>{/if}
	{#if batches.length}<section class="delivery">
			<h3>Delivery history</h3>
			<p>
				Provider events update delivery status. Open counts are unreliable aggregate signals and do
				not establish that a person read a message.
			</p>
			{#each batches as batch}<article>
					<strong>{batch.subject || 'Email send'}</strong><span
						>{batch.status} · {batch.recipientCount} recipients · {batch.deliveredCount} delivered · {batch.issueCount}
						issues</span
					>{#if batch.scheduledAt}<span
							>Scheduled {new Date(batch.scheduledAt).toLocaleString()} ({batch.scheduledTimeZone})</span
						>{/if}{#if batch.opens || batch.clicks}<span
							>{batch.opens || 0} opens (unreliable) · {batch.clicks || 0} clicks</span
						>{/if}
				</article>{/each}
		</section>{/if}
</section>

<style>
	.studio {
		display: grid;
		gap: 1rem;
	}
	.studio header h2 {
		margin: 0.25rem 0;
	}
	.studio header p,
	.muted,
	.delivery p {
		color: #66706d;
	}
	.grid {
		display: grid;
		grid-template-columns: minmax(0, 1.4fr) minmax(18rem, 0.8fr);
		gap: 1rem;
		align-items: start;
	}
	.draft-controls {
		display: flex;
		align-items: end;
		flex-wrap: wrap;
		gap: 0.6rem;
	}
	.draft-controls label {
		display: grid;
		gap: 0.3rem;
		min-width: min(100%, 18rem);
		font-size: 0.85rem;
	}
	.editor,
	.preview,
	.approval,
	.delivery {
		background: #fff;
		border: 1px solid #e1e6e3;
		border-radius: 14px;
		padding: 1rem;
		display: grid;
		gap: 0.8rem;
	}
	.editor-fields {
		min-width: 0;
		width: 100%;
		margin: 0;
		padding: 0;
		border: 0;
		display: grid;
		gap: 0.8rem;
	}
	.editor label,
	.preview {
		display: grid;
		gap: 0.35rem;
	}
	.editor input,
	.editor textarea,
	.editor select {
		font: inherit;
		width: 100%;
		padding: 0.65rem;
		border: 1px solid #cbd4cf;
		border-radius: 8px;
	}
	.field-row {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 0.8rem;
	}
	.toolbar,
	.move {
		display: flex;
		gap: 0.5rem;
		flex-wrap: wrap;
	}
	.toolbar button,
	.move button,
	.approval button {
		border: 1px solid #b9c7bf;
		background: #f5f8f6;
		padding: 0.55rem 0.75rem;
		border-radius: 8px;
		cursor: pointer;
	}
	.toolbar button:disabled,
	.move button:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
	.blocks {
		display: grid;
		gap: 0.6rem;
	}
	.blocks fieldset {
		border: 1px solid #e0e6e2;
		border-radius: 10px;
		padding: 0.8rem;
		display: grid;
		gap: 0.55rem;
	}
	.blocks legend {
		font-weight: 650;
	}
	.preview iframe {
		width: 100%;
		height: 24rem;
		border: 1px solid #e2e8e4;
		border-radius: 8px;
		background: #fff;
	}
	.preview pre {
		white-space: pre-wrap;
		overflow-wrap: anywhere;
		font: inherit;
		background: #f7f9f8;
		padding: 0.8rem;
		border-radius: 8px;
	}
	.test-send {
		display: grid;
		gap: 0.5rem;
		padding: 0.75rem;
		border: 1px solid #e1e6e3;
		border-radius: 9px;
	}
	.test-send label {
		display: flex;
		gap: 0.5rem;
		align-items: flex-start;
	}
	.test-send input {
		width: auto;
	}
	.test-send button {
		justify-self: start;
	}
	.approval ul {
		max-height: 14rem;
		overflow: auto;
	}
	.confirm {
		display: flex;
		gap: 0.5rem;
		align-items: flex-start;
	}
	.alert {
		background: #fff2e5;
		color: #684318;
		padding: 0.8rem;
		border-radius: 8px;
	}
	.notice {
		background: #eaf7f0;
		color: #1b5b3c;
		padding: 0.8rem;
		border-radius: 8px;
	}
	.delivery article {
		display: grid;
		padding: 0.7rem 0;
		border-top: 1px solid #e5e9e6;
	}
	.delivery article span {
		color: #66706d;
		font-size: 0.9rem;
	}
	@media (max-width: 850px) {
		.grid,
		.field-row {
			grid-template-columns: 1fr;
		}
	}
</style>
