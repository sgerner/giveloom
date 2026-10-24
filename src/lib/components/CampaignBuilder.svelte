<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import QRCode from 'qrcode';
	import ContactPicker from '$lib/components/ContactPicker.svelte';
	import {
		BookOpen,
		CircleCheck,
		Clock3,
		ExternalLink,
		Link2,
		Plus,
		QrCode,
		Save,
		Send,
		Users
	} from 'lucide-svelte';
	let { tenant } = $props<{ tenant: string }>();
	const blank = () => ({
		name: 'New campaign',
		publicSlug: 'new-campaign',
		description: 'Help our community thrive through a shared act of generosity.',
		story:
			'Every gift helps our community grow stronger. Your support makes this local work possible for the neighbors who need it most.',
		goalMinor: 0,
		currency: 'USD',
		fundId: null as string | null,
		appealId: null as string | null,
		startsAt: null as string | null,
		endsAt: null as string | null,
		budgetMinor: 0,
		channels: [] as string[],
		audienceSegments: [] as string[],
		utmSource: '',
		utmMedium: '',
		utmCampaign: '',
		heroImageFileId: null as string | null,
		receiptTemplate: {
			thankYouMessage: 'Thank you for supporting our work.',
			disclaimer:
				'Donation acknowledgment only. This is not tax advice or a determination of deductibility.'
		},
		formConfig: {
			frequencies: ['once'],
			suggestedAmounts: [2500, 5000, 10000, 25000],
			allowCustomAmount: true,
			askForAddress: false,
			allowAnonymous: true,
			allowTribute: true,
			allowFeeCoverage: false,
			feeCoverageBasisPoints: 0,
			feeCoverageFixedMinor: 0,
			allowDesignation: false,
			designationFundIds: [] as string[],
			terms: 'I authorize this gift to the organization.',
			privacyUrl: ''
		},
		acceptsOnlineGifts: true
	});
	let campaigns = $state<any[]>([]),
		funds = $state<any[]>([]),
		appeals = $state<any[]>([]);
	let selectedId = $state(''),
		draft = $state<any>(blank()),
		version = $state(1),
		published = $state(false),
		ready = $state(false),
		saving = $state(false),
		message = $state(''),
		error = $state('');
	let history = $state<any[]>([]),
		variants = $state<any[]>([]),
		links = $state<any[]>([]),
		fundraisers = $state<any[]>([]),
		qr = $state<Record<string, string>>({});
	let emailDrafts = $state<any[]>([]),
		emailVariantResults = $state<any[]>([]),
		emailDraftId = $state(''),
		subjectA = $state(''),
		subjectB = $state(''),
		emailPreview = $state<any | null>(null),
		emailBusy = $state(false);
	let fundName = $state(''),
		fundSlug = $state(''),
		appealName = $state(''),
		appealSlug = $state('');
	let variantName = $state('Alternate headline'),
		variantHeadline = $state('A little more good starts here'),
		variantWeight = $state(50);
	let linkLabel = $state(''),
		linkVariantId = $state(''),
		linkFundraiserId = $state('');
	let peerName = $state(''),
		peerSlug = $state(''),
		peerStory = $state(''),
		peerType = $state<'individual' | 'team'>('individual'),
		peerContact = $state(''),
		peerGoal = $state(0);
	let timer: ReturnType<typeof setTimeout> | undefined;
	let draftRevision = 0;
	const base = `/api/v1/campaigns`;
	async function request(path: string, init: RequestInit = {}) {
		const multipart = typeof FormData !== 'undefined' && init.body instanceof FormData;
		const response = await fetch(path, {
			...init,
			headers: {
				...(multipart ? {} : { 'content-type': 'application/json' }),
				...(init.headers || {})
			}
		});
		const body = await response
			.json()
			.catch(() => ({ error: 'The server returned an unreadable response.' }));
		if (!response.ok) throw new Error(body.error || 'Request failed.');
		return body;
	}
	async function loadLists() {
		const [campaignRes, fundRes, appealRes] = await Promise.all([
			request(base),
			request(`${base}/funds`),
			request(`${base}/appeals`)
		]);
		campaigns = campaignRes.campaigns;
		funds = fundRes.funds;
		appeals = appealRes.appeals;
		if (!selectedId && campaigns[0]) await selectCampaign(campaigns[0].id);
	}
	let status = $state('draft');
	async function selectCampaign(id: string) {
		if (saving || message === 'Unsaved changes') return;
		clearTimeout(timer);
		error = '';
		message = '';
		const result = await request(`${base}/${encodeURIComponent(id)}`);
		selectedId = id;
		version = result.version;
		status = result.status;
		draftRevision = 0;
		draft = {
			...blank(),
			...result.draft,
			formConfig: { ...blank().formConfig, ...result.draft.formConfig },
			receiptTemplate: { ...blank().receiptTemplate, ...result.draft.receiptTemplate }
		};
		published = ['published', 'scheduled', 'paused'].includes(status);
		ready = true;
		await loadExtras();
		void loadEmailDrafts();
	}
	async function loadExtras() {
		if (!selectedId) return;
		const [historyRes, variantRes, linkRes, peerRes] = await Promise.all([
			request(`${base}/${selectedId}/versions`),
			request(`${base}/${selectedId}/variants`),
			request(`${base}/${selectedId}/links`),
			request(`${base}/${selectedId}/fundraisers`)
		]);
		history = historyRes.versions;
		variants = variantRes.variants;
		links = linkRes.links;
		fundraisers = peerRes.pages;
		await Promise.all(
			links.map(async (link) => {
				qr[link.id] = await QRCode.toDataURL(
					new URL(
						`/donate/${encodeURIComponent(tenant)}/${encodeURIComponent(selectedId)}?ref=${encodeURIComponent(link.code)}`,
						location.origin
					).href,
					{ margin: 1, width: 148, color: { dark: '#223e34', light: '#ffffff' } }
				);
			})
		);
		void loadEmailTestResults();
	}
	async function loadEmailDrafts() {
		try {
			const result = await request('/api/v1/email');
			emailDrafts = (result.emails || []).filter((email: any) =>
				['draft', 'review', undefined].includes(email.data?.status)
			);
			if (!emailDraftId && emailDrafts[0]) emailDraftId = emailDrafts[0].id;
		} catch {
			emailDrafts = [];
		}
	}
	async function loadEmailTestResults() {
		try {
			const result = await request(`${base}/${selectedId}/email-variants/results`);
			emailVariantResults = result.variants || [];
		} catch {
			emailVariantResults = [];
		}
	}
	async function previewEmailVariants() {
		if (!selectedId || !emailDraftId) return;
		emailBusy = true;
		emailPreview = null;
		error = '';
		try {
			emailPreview = await request('/api/v1/email/preview', {
				method: 'POST',
				body: JSON.stringify({
					emailId: emailDraftId,
					campaignId: selectedId,
					variantSubjects: { A: subjectA, B: subjectB }
				})
			});
		} catch (e) {
			error = e instanceof Error ? e.message : 'Email test preview failed.';
		} finally {
			emailBusy = false;
		}
	}
	async function approveEmailVariants() {
		if (!emailPreview?.previewToken) return;
		emailBusy = true;
		error = '';
		try {
			const result = await request('/api/v1/email/send', {
				method: 'POST',
				body: JSON.stringify({ previewToken: emailPreview.previewToken, approved: true })
			});
			message = `Approved campaign email test; ${result.queued} messages queued.`;
			emailPreview = null;
			await loadEmailTestResults();
		} catch (e) {
			error = e instanceof Error ? e.message : 'Campaign email test could not be approved.';
		} finally {
			emailBusy = false;
		}
	}
	function queueSave() {
		if (!selectedId || !ready) return;
		draftRevision++;
		clearTimeout(timer);
		message = 'Unsaved changes';
		timer = setTimeout(() => void saveDraft(), 650);
	}
	async function saveDraft() {
		if (!selectedId || !ready) return false;
		if (saving) {
			clearTimeout(timer);
			timer = setTimeout(() => void saveDraft(), 650);
			return false;
		}
		saving = true;
		error = '';
		const revision = draftRevision;
		const snapshot = JSON.parse(JSON.stringify(draft));
		try {
			const result = await request(`${base}/${selectedId}`, {
				method: 'PATCH',
				body: JSON.stringify({ expectedVersion: version, draft: snapshot })
			});
			version = result.version;
			if (revision === draftRevision) draft = result.draft;
			message = `Saved version ${version}`;
			void loadExtras();
			void loadLists();
			if (revision !== draftRevision) {
				clearTimeout(timer);
				timer = setTimeout(() => void saveDraft(), 50);
			}
			return true;
		} catch (e) {
			error = e instanceof Error ? e.message : 'Draft could not be saved.';
			return false;
		} finally {
			saving = false;
		}
	}
	async function createCampaign() {
		error = '';
		try {
			const next = { ...blank(), publicSlug: `new-campaign-${crypto.randomUUID().slice(0, 8)}` };
			const result = await request(base, {
				method: 'POST',
				body: JSON.stringify({ tenant, draft: next })
			});
			await loadLists();
			await selectCampaign(result.id);
		} catch (e) {
			error = e instanceof Error ? e.message : 'Campaign could not be created.';
		}
	}
	async function publish() {
		error = '';
		try {
			clearTimeout(timer);
			if (!(await saveDraft())) return;
			const result = await request(`${base}/${selectedId}/publish`, { method: 'POST' });
			status = result.status;
			published = true;
			message =
				result.status === 'scheduled'
					? 'Campaign scheduled; it will become public at its start time.'
					: `Published at /donate/${tenant}/${selectedId}`;
			await loadLists();
		} catch (e) {
			error = e instanceof Error ? e.message : 'Campaign could not be published.';
		}
	}
	async function setPaused(paused: boolean) {
		error = '';
		try {
			const result = await request(`${base}/${selectedId}/${paused ? 'pause' : 'resume'}`, {
				method: 'POST'
			});
			status = result.status;
			published = true;
			message = paused
				? 'Campaign paused; public giving is off.'
				: result.status === 'scheduled'
					? 'Campaign resumed and remains scheduled.'
					: 'Campaign resumed.';
			await loadLists();
		} catch (e) {
			error = e instanceof Error ? e.message : 'Campaign status could not be changed.';
		}
	}
	async function uploadHero(event: Event) {
		const input = event.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;
		error = '';
		try {
			if (!(await saveDraft())) return;
			const form = new FormData();
			form.set('file', file);
			const result = await request(`${base}/${selectedId}/hero-image`, {
				method: 'POST',
				headers: {},
				body: form
			});
			version = result.version;
			draft.heroImageFileId = result.heroImageFileId;
			draftRevision++;
			message = 'Campaign image saved to this draft.';
			queueSave();
		} catch (e) {
			error = e instanceof Error ? e.message : 'Campaign image could not be uploaded.';
		} finally {
			input.value = '';
		}
	}
	function localDateTime(value: string | null) {
		if (!value) return '';
		const date = new Date(value);
		return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
	}
	function setDateTime(field: 'startsAt' | 'endsAt', value: string) {
		draft[field] = value ? new Date(value).toISOString() : null;
		queueSave();
	}
	function toggleList(field: 'channels' | 'audienceSegments', value: string, checked: boolean) {
		draft[field] = checked
			? [...new Set([...draft[field], value])]
			: draft[field].filter((item: string) => item !== value);
		queueSave();
	}
	async function createFund() {
		try {
			const result = await request(`${base}/funds`, {
				method: 'POST',
				body: JSON.stringify({
					tenant,
					fund: { name: fundName, slug: fundSlug, description: '', restricted: false }
				})
			});
			funds = [...funds, result];
			draft.fundId = result.id;
			fundName = '';
			fundSlug = '';
			queueSave();
		} catch (e) {
			error = e instanceof Error ? e.message : 'Fund could not be created.';
		}
	}
	async function createAppeal() {
		try {
			const result = await request(`${base}/appeals`, {
				method: 'POST',
				body: JSON.stringify({
					tenant,
					appeal: { name: appealName, slug: appealSlug, fundId: draft.fundId, description: '' }
				})
			});
			appeals = [...appeals, result];
			draft.appealId = result.id;
			appealName = '';
			appealSlug = '';
			queueSave();
		} catch (e) {
			error = e instanceof Error ? e.message : 'Appeal could not be created.';
		}
	}
	async function createVariant() {
		try {
			await request(`${base}/${selectedId}/variants`, {
				method: 'POST',
				body: JSON.stringify({
					name: variantName,
					weight: variantWeight,
					content: { headline: variantHeadline, description: draft.description }
				})
			});
			await loadExtras();
			message = 'Variant added to the public test.';
		} catch (e) {
			error = e instanceof Error ? e.message : 'Variant could not be added.';
		}
	}
	async function createLink() {
		try {
			const body: any = { label: linkLabel };
			if (linkVariantId) body.variantId = linkVariantId;
			if (linkFundraiserId) body.fundraiserId = linkFundraiserId;
			const link = await request(`${base}/${selectedId}/links`, {
				method: 'POST',
				body: JSON.stringify(body)
			});
			links = [link, ...links];
			qr[link.id] = await QRCode.toDataURL(new URL(link.path, location.origin).href, {
				margin: 1,
				width: 148,
				color: { dark: '#223e34', light: '#ffffff' }
			});
			linkLabel = '';
			message = 'Shareable donation link and QR created.';
		} catch (e) {
			error = e instanceof Error ? e.message : 'Donation link could not be created.';
		}
	}
	async function createPeer() {
		try {
			const body: any = {
				slug: peerSlug,
				pageType: peerType,
				name: peerName,
				story: peerStory,
				goalMinor: peerGoal,
				publish: true
			};
			if (peerType === 'individual') body.contactId = peerContact;
			const page = await request(`${base}/${selectedId}/fundraisers`, {
				method: 'POST',
				body: JSON.stringify(body)
			});
			fundraisers = [page, ...fundraisers];
			linkFundraiserId = page.id;
			peerName = '';
			peerSlug = '';
			peerStory = '';
			peerGoal = 0;
			message = 'Public fundraising page created.';
		} catch (e) {
			error = e instanceof Error ? e.message : 'Fundraising page could not be created.';
		}
	}
	async function showHistory() {
		try {
			history = (await request(`${base}/${selectedId}/versions`)).versions;
		} catch (e) {
			error = e instanceof Error ? e.message : 'Version history unavailable.';
		}
	}
	function restore(item: any) {
		draft = {
			...blank(),
			...item.snapshot,
			formConfig: { ...blank().formConfig, ...item.snapshot.formConfig }
		};
		queueSave();
		message = `Restoring version ${item.version} as a new draft version.`;
	}
	onMount(() => {
		void loadLists().catch(
			(e) => (error = e instanceof Error ? e.message : 'Campaign builder is unavailable.')
		);
	});
	onDestroy(() => clearTimeout(timer));
</script>

<section class="campaign-builder" aria-labelledby="campaign-builder-title">
	<header class="builder-head">
		<div>
			<p class="eyebrow">CAMPAIGN STUDIO</p>
			<h2 id="campaign-builder-title">A story worth sharing.</h2>
			<p>Drafts save as you edit. Publishing validates payment and donor consent settings.</p>
		</div>
		<button
			class="primary"
			type="button"
			onclick={createCampaign}
			disabled={saving || message === 'Unsaved changes'}><Plus size={17} /> New campaign</button
		>
	</header>
	{#if error}<p class="notice error" role="alert">{error}</p>{/if}{#if message}<p
			class="notice"
			role="status"
		>
			{message}
		</p>{/if}
	{#if campaigns.length}<div class="campaign-layout">
			<nav class="campaign-list" aria-label="Campaign drafts">
				{#each campaigns as campaign}<button
						type="button"
						disabled={saving || message === 'Unsaved changes'}
						class:current={selectedId === campaign.id}
						onclick={() => void selectCampaign(campaign.id)}
						><strong>{campaign.name}</strong><span
							>{campaign.status} · v{campaign.draftVersion}</span
						></button
					>{/each}
			</nav>
			<div class="editor" aria-busy={saving}>
				<div class="editor-title">
					<div>
						<p class="eyebrow">{published ? 'LIVE PAGE · DRAFT EDITS' : 'DRAFT'}</p>
						<h3>{draft.name}</h3>
					</div>
					<span class="save-state"
						><Save size={15} />{saving ? 'Saving…' : message || `Version ${version}`}</span
					>
				</div>
				<div class="form-grid">
					<label
						>Campaign name<input
							bind:value={draft.name}
							maxlength="140"
							oninput={queueSave}
						/></label
					><label
						>Public address<input
							bind:value={draft.publicSlug}
							maxlength="72"
							oninput={queueSave}
							aria-describedby="slug-help"
						/><small id="slug-help">/donate/{tenant}/{draft.publicSlug}</small></label
					>
					<label
						>Fund<select bind:value={draft.fundId} onchange={queueSave}
							><option value={null}>General giving</option>{#each funds as fund}<option
									value={fund.id}>{fund.name}</option
								>{/each}</select
						></label
					><label
						>Appeal<select bind:value={draft.appealId} onchange={queueSave}
							><option value={null}>No appeal</option
							>{#each appeals.filter((item: any) => !draft.fundId || item.fundId === draft.fundId) as appeal}<option
									value={appeal.id}>{appeal.name}</option
								>{/each}</select
						></label
					>
					<label
						>Goal (minor currency units)<input
							type="number"
							min="0"
							bind:value={draft.goalMinor}
							oninput={queueSave}
						/></label
					><label
						>Currency<input bind:value={draft.currency} maxlength="3" oninput={queueSave} /></label
					>
					<label class="wide"
						>Short description<textarea
							rows="3"
							bind:value={draft.description}
							maxlength="2400"
							oninput={queueSave}></textarea></label
					><label class="wide"
						>Campaign story<textarea
							rows="8"
							bind:value={draft.story}
							maxlength="20000"
							oninput={queueSave}
							aria-describedby="story-help"></textarea><small id="story-help"
							>At least 40 characters to publish.</small
						></label
					>
				</div>
				<details class="settings" open>
					<summary><BookOpen size={17} /> Schedule, audience and tracking</summary>
					<div class="form-grid">
						<label
							>Starts at<input
								type="datetime-local"
								value={localDateTime(draft.startsAt)}
								onchange={(event) => setDateTime('startsAt', event.currentTarget.value)}
							/><small>Leave blank to publish now.</small></label
						>
						<label
							>Ends at<input
								type="datetime-local"
								value={localDateTime(draft.endsAt)}
								onchange={(event) => setDateTime('endsAt', event.currentTarget.value)}
							/><small>After this time the public page and checkout close.</small></label
						>
						<label
							>Campaign budget, minor units<input
								type="number"
								min="0"
								max="100000000000"
								bind:value={draft.budgetMinor}
								oninput={() => {
									draft.budgetMinor = Number(draft.budgetMinor);
									queueSave();
								}}
							/></label
						>
						<div class="wide">
							<p class="field-title">Channels</p>
							<div class="checks">
								{#each [{ id: 'web', label: 'Website' }, { id: 'email', label: 'Email' }, { id: 'social', label: 'Social' }, { id: 'direct_mail', label: 'Direct mail' }, { id: 'event', label: 'Events' }, { id: 'partner', label: 'Partners' }, { id: 'other', label: 'Other' }] as channel}<label
										><input
											type="checkbox"
											checked={draft.channels.includes(channel.id)}
											onchange={(event) =>
												toggleList('channels', channel.id, event.currentTarget.checked)}
										/>{channel.label}</label
									>{/each}
							</div>
						</div>
						<div class="wide">
							<p class="field-title">Audience segments</p>
							<div class="checks">
								{#each [{ id: 'new_donors', label: 'New donors' }, { id: 'recurring_donors', label: 'Recurring donors' }, { id: 'lapsed_donors', label: 'Lapsed donors' }, { id: 'volunteers', label: 'Volunteers' }, { id: 'event_attendees', label: 'Event attendees' }, { id: 'community', label: 'Community' }, { id: 'major_givers', label: 'Major givers' }] as segment}<label
										><input
											type="checkbox"
											checked={draft.audienceSegments.includes(segment.id)}
											onchange={(event) =>
												toggleList('audienceSegments', segment.id, event.currentTarget.checked)}
										/>{segment.label}</label
									>{/each}
							</div>
						</div>
						<label
							>UTM source<input
								maxlength="80"
								bind:value={draft.utmSource}
								oninput={queueSave}
							/></label
						><label
							>UTM medium<input
								maxlength="80"
								bind:value={draft.utmMedium}
								oninput={queueSave}
							/></label
						><label
							>UTM campaign<input
								maxlength="80"
								bind:value={draft.utmCampaign}
								oninput={queueSave}
							/></label
						>
						<label class="wide"
							>Campaign hero image<input
								type="file"
								accept="image/png,image/jpeg,image/webp"
								onchange={uploadHero}
							/><small
								>PNG, JPEG, or WebP up to 5 MiB. Images are checked before they can appear on a
								public page.</small
							>{#if draft.heroImageFileId}<small
									>Image attached to this draft. It becomes public when the campaign is published.</small
								>{/if}</label
						>
						<label class="wide"
							>Receipt thank-you message<textarea
								rows="2"
								maxlength="500"
								bind:value={draft.receiptTemplate.thankYouMessage}
								oninput={queueSave}></textarea></label
						><label class="wide"
							>Receipt acknowledgment disclaimer<textarea
								rows="2"
								minlength="12"
								maxlength="500"
								bind:value={draft.receiptTemplate.disclaimer}
								oninput={queueSave}></textarea></label
						>
					</div>
				</details>
				<section class="publish-preview" aria-label="Publishing preview">
					<div>
						<p class="eyebrow">PUBLICATION PREVIEW</p>
						<h3>{draft.name}</h3>
						<p>{draft.description}</p>
						<small
							>{status === 'paused'
								? 'Paused'
								: status === 'scheduled'
									? 'Scheduled'
									: published
										? 'Published'
										: 'Draft'} · {draft.startsAt
								? `starts ${new Date(draft.startsAt).toLocaleString()}`
								: 'starts when published'}{draft.endsAt
								? ` · ends ${new Date(draft.endsAt).toLocaleString()}`
								: ''}</small
						><small
							>{draft.channels.length
								? `Channels: ${draft.channels.join(', ')}`
								: 'No channels selected'} · Goal {draft.goalMinor}
							{draft.currency}</small
						>
					</div>
					{#if draft.heroImageFileId && status === 'published'}<img
							src={`/campaign-image/${encodeURIComponent(tenant)}/${encodeURIComponent(selectedId)}`}
							alt={draft.name}
							loading="lazy"
						/>{:else if draft.heroImageFileId}<small
							>Hero image uploaded privately; it appears publicly once the campaign is live.</small
						>{/if}
				</section>
				<details class="settings" open>
					<summary><BookOpen size={17} /> Donation form and consent</summary>
					<div class="form-grid">
						<label class="wide"
							>Donor authorization terms<textarea
								rows="3"
								bind:value={draft.formConfig.terms}
								oninput={queueSave}
								maxlength="1000"></textarea></label
						><label
							>Suggested amounts in cents<input
								value={draft.formConfig.suggestedAmounts.join(', ')}
								oninput={(event) => {
									const values = (event.currentTarget as HTMLInputElement).value
										.split(',')
										.map((v) => Number(v.trim()))
										.filter((v) => Number.isInteger(v) && v >= 50 && v <= 25000000);
									draft.formConfig.suggestedAmounts = values;
									queueSave();
								}}
							/></label
						><label
							>Privacy policy URL<input
								type="url"
								bind:value={draft.formConfig.privacyUrl}
								oninput={queueSave}
							/></label
						>
						<div class="checks">
							<label
								><input
									type="checkbox"
									bind:checked={draft.acceptsOnlineGifts}
									onchange={queueSave}
								/> Accept online gifts</label
							><label
								><input
									type="checkbox"
									bind:checked={draft.formConfig.allowCustomAmount}
									onchange={queueSave}
								/> Allow custom amount</label
							><label
								><input
									type="checkbox"
									checked={draft.formConfig.frequencies.includes('monthly')}
									onchange={(event) => {
										draft.formConfig.frequencies = event.currentTarget.checked
											? [...new Set([...draft.formConfig.frequencies, 'monthly'])]
											: draft.formConfig.frequencies.filter((v: string) => v !== 'monthly');
										queueSave();
									}}
								/> Offer monthly giving</label
							><label
								><input
									type="checkbox"
									checked={draft.formConfig.frequencies.includes('annual')}
									onchange={(event) => {
										draft.formConfig.frequencies = event.currentTarget.checked
											? [...new Set([...draft.formConfig.frequencies, 'annual'])]
											: draft.formConfig.frequencies.filter((v: string) => v !== 'annual');
										queueSave();
									}}
								/> Offer annual giving</label
							><label
								><input
									type="checkbox"
									bind:checked={draft.formConfig.askForAddress}
									onchange={queueSave}
								/> Ask for donor address</label
							><label
								><input
									type="checkbox"
									bind:checked={draft.formConfig.allowAnonymous}
									onchange={queueSave}
								/> Allow anonymous attribution</label
							><label
								><input
									type="checkbox"
									bind:checked={draft.formConfig.allowTribute}
									onchange={queueSave}
								/> Allow honor or memory tributes</label
							><label
								><input
									type="checkbox"
									bind:checked={draft.formConfig.allowFeeCoverage}
									onchange={queueSave}
								/> Allow donor fee coverage</label
							><label
								><input
									type="checkbox"
									bind:checked={draft.formConfig.allowDesignation}
									onchange={queueSave}
								/> Allow donor to choose designated funds</label
							>
						</div>
						{#if draft.formConfig.allowFeeCoverage}<div class="form-grid">
								<label
									>Fee coverage basis points<input
										type="number"
										min="0"
										max="3000"
										bind:value={draft.formConfig.feeCoverageBasisPoints}
										oninput={() => {
											draft.formConfig.feeCoverageBasisPoints = Number(
												draft.formConfig.feeCoverageBasisPoints
											);
											queueSave();
										}}
									/></label
								><label
									>Fixed fee, cents<input
										type="number"
										min="0"
										max="500"
										bind:value={draft.formConfig.feeCoverageFixedMinor}
										oninput={() => {
											draft.formConfig.feeCoverageFixedMinor = Number(
												draft.formConfig.feeCoverageFixedMinor
											);
											queueSave();
										}}
									/></label
								>
							</div>{/if}{#if draft.formConfig.allowDesignation}<label class="wide"
								>Donor-selectable funds<select
									multiple
									bind:value={draft.formConfig.designationFundIds}
									onchange={queueSave}
									>{#each funds as fund}<option value={fund.id}>{fund.name}</option>{/each}</select
								><small
									>Only active funds selected here will be available on the public donation form.</small
								></label
							>{/if}
					</div>
				</details>
				<div class="actions">
					<button class="secondary" type="button" onclick={() => void saveDraft()} disabled={saving}
						><Save size={16} /> Save draft</button
					><button class="primary" type="button" onclick={publish} disabled={saving}
						><Send size={16} /> Publish or update</button
					>{#if status === 'published' || status === 'scheduled'}<button
							class="secondary"
							type="button"
							onclick={() => setPaused(true)}
							disabled={saving}>Pause giving</button
						>{:else if status === 'paused'}<button
							class="secondary"
							type="button"
							onclick={() => setPaused(false)}
							disabled={saving}>Resume giving</button
						>{/if}{#if published && status !== 'paused'}<a
							class="text-link"
							href={`/donate/${tenant}/${selectedId}`}
							target="_blank"
							rel="noopener noreferrer"><ExternalLink size={15} /> Public page</a
						>{/if}<button class="text-link" type="button" onclick={showHistory}
						><Clock3 size={15} /> Version history</button
					>
				</div>
				{#if history.length}<details class="settings">
						<summary>Previous versions</summary>
						<ul class="version-list">
							{#each history as item}<li>
									<span>Version {item.version} · {new Date(item.createdAt).toLocaleString()}</span
									><button class="quiet" type="button" onclick={() => restore(item)}
										>Restore as draft</button
									>
								</li>{/each}
						</ul>
					</details>{/if}
				<div class="management-grid">
					<section class="subpanel">
						<h3><Users size={17} /> Peer and team pages</h3>
						<form
							onsubmit={(event) => {
								event.preventDefault();
								void createPeer();
							}}
						>
							<label
								>Page type<select bind:value={peerType}
									><option value="individual">Individual fundraiser</option><option value="team"
										>Team fundraiser</option
									></select
								></label
							>{#if peerType === 'individual'}<ContactPicker
									{tenant}
									bind:contactId={peerContact}
									label="Workspace contact"
									placeholder="Search fundraiser by name or email…"
									required
								/>{/if}<label
								>Page name<input bind:value={peerName} required maxlength="120" /></label
							><label>Public slug<input bind:value={peerSlug} required maxlength="72" /></label
							><label
								>Story<textarea bind:value={peerStory} required minlength="10" rows="3"
								></textarea></label
							><label>Goal in cents<input type="number" min="0" bind:value={peerGoal} /></label
							><button class="secondary" type="submit" disabled={!published}
								>Create public page</button
							>
						</form>
						{#each fundraisers as page}<p class="resource-row">
								<a
									href={`/fundraise/${tenant}/${page.slug}`}
									target="_blank"
									rel="noopener noreferrer">{page.name} · {page.status}</a
								><span>{page.pageType}</span>
							</p>{/each}
					</section>
					<section class="subpanel">
						<h3><QrCode size={17} /> Donation links and QR codes</h3>
						<form
							onsubmit={(event) => {
								event.preventDefault();
								void createLink();
							}}
						>
							<label
								>Link label<input
									bind:value={linkLabel}
									maxlength="100"
									placeholder="Newsletter, table tent…"
								/></label
							><label
								>A/B variant<select bind:value={linkVariantId}
									><option value="">Use default story</option>{#each variants as variant}<option
											value={variant.id}>{variant.name}</option
										>{/each}</select
								></label
							><label
								>Fundraiser page<select bind:value={linkFundraiserId}
									><option value="">General campaign</option>{#each fundraisers as page}<option
											value={page.id}>{page.name}</option
										>{/each}</select
								></label
							><button class="secondary" type="submit" disabled={!published}
								><Link2 size={15} /> Create share link</button
							>
						</form>
						{#each links as link}<div class="link-row">
								<div>
									<strong>{link.label || 'Donation link'}</strong><a
										href={`/donate/${tenant}/${selectedId}?ref=${link.code}`}
										target="_blank"
										rel="noopener noreferrer">/donate/{tenant}/{selectedId}?ref={link.code}</a
									><small>{link.clicks} attributed clicks</small>
								</div>
								{#if qr[link.id]}<img
										src={qr[link.id]}
										alt={`QR code for ${link.label || 'donation link'}`}
										width="92"
										height="92"
									/>{/if}
							</div>{/each}
					</section>
					<section class="subpanel">
						<h3><CircleCheck size={17} /> A/B story variants</h3>
						<form
							onsubmit={(event) => {
								event.preventDefault();
								void createVariant();
							}}
						>
							<label>Variant name<input bind:value={variantName} required maxlength="80" /></label
							><label>Headline<input bind:value={variantHeadline} required maxlength="140" /></label
							><label
								>Relative test weight<input
									type="number"
									min="1"
									max="99"
									bind:value={variantWeight}
								/></label
							><button class="secondary" type="submit" disabled={!published}>Add variant</button>
						</form>
						{#each variants as variant}<p class="resource-row">
								<strong>{variant.name}</strong><span
									>{variant.impressions} visits · {variant.conversions} conversions</span
								>
							</p>{/each}
					</section>
					<section class="subpanel">
						<h3><Send size={17} /> A/B email subject test</h3>
						<p class="muted">
							Choose an email draft and two subjects. The preview freezes one deterministic 50/50
							assignment per recipient; approval queues each recipient once.
						</p>
						<form
							onsubmit={(event) => {
								event.preventDefault();
								void previewEmailVariants();
							}}
						>
							<label
								>Email draft<select bind:value={emailDraftId} required
									><option value="">Choose a draft</option>{#each emailDrafts as email}<option
											value={email.id}>{email.data?.name || email.data?.subject || email.id}</option
										>{/each}</select
								></label
							><label>Subject A<input bind:value={subjectA} maxlength="998" required /></label
							><label>Subject B<input bind:value={subjectB} maxlength="998" required /></label
							><button
								class="secondary"
								type="submit"
								disabled={!published || !emailDraftId || emailBusy}
								>{emailBusy ? 'Preparing…' : 'Preview recipients and split'}</button
							>
						</form>
						{#if emailPreview}<div class="variant-preview">
								<p>
									<strong>{emailPreview.count} recipients</strong> · A: {emailPreview.variantCounts
										?.A || 0} · B: {emailPreview.variantCounts?.B || 0}
								</p>
								<p>
									From {emailPreview.from}. No duplicate recipients. This approval expires {new Date(
										emailPreview.expiresAt
									).toLocaleTimeString()}.
								</p>
								<button
									class="primary"
									type="button"
									disabled={!emailPreview.previewToken || !emailPreview.withinQuota || emailBusy}
									onclick={approveEmailVariants}>Approve and queue this test</button
								>
							</div>{/if}{#each emailVariantResults as result}<p class="resource-row">
								<strong>Subject {result.variant}: {result.subject}</strong><span
									>{result.assigned} assigned · {result.delivered} delivered · {result.issues} issues</span
								>
							</p>{/each}
					</section>
				</div>
			</div>
		</div>{:else}<div class="empty">
			<p>No campaigns yet.</p>
			<button class="primary" type="button" onclick={createCampaign}
				><Plus size={17} /> Start a campaign draft</button
			>
		</div>{/if}
	<details class="fund-admin">
		<summary>Manage funds and appeals</summary>
		<div class="fund-grid">
			<form
				onsubmit={(event) => {
					event.preventDefault();
					void createFund();
				}}
			>
				<h3>New fund</h3>
				<label>Name<input bind:value={fundName} required /></label><label
					>Slug<input bind:value={fundSlug} required pattern="[a-z0-9]+(-[a-z0-9]+)*" /></label
				><button class="secondary" type="submit">Add fund</button>
			</form>
			<form
				onsubmit={(event) => {
					event.preventDefault();
					void createAppeal();
				}}
			>
				<h3>New appeal</h3>
				<label>Name<input bind:value={appealName} required /></label><label
					>Slug<input bind:value={appealSlug} required pattern="[a-z0-9]+(-[a-z0-9]+)*" /></label
				><button class="secondary" type="submit" disabled={!draft.fundId}>Add appeal</button>
			</form>
		</div>
	</details>
</section>

<style>
	.campaign-builder {
		color: var(--ink);
		display: grid;
		gap: 1rem;
	}
	.builder-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		border-bottom: 1px solid var(--line);
		padding-bottom: 1.2rem;
	}
	.builder-head h2 {
		margin: 0.25rem 0;
	}
	.builder-head p:not(.eyebrow) {
		color: var(--muted);
		max-width: 52rem;
	}
	.eyebrow {
		font-size: 0.66rem;
		letter-spacing: 0.12em;
		color: var(--muted);
	}
	.primary,
	.secondary {
		min-height: 44px;
		padding: 0.65rem 0.9rem;
		border: 1px solid var(--line);
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 0.45rem;
		background: var(--accent);
		color: var(--paper);
		font: inherit;
		font-weight: 600;
	}
	.secondary {
		background: var(--soft);
		color: var(--ink);
	}
	button:disabled {
		opacity: 0.55;
		cursor: not-allowed;
	}
	.notice {
		padding: 0.7rem 0.9rem;
		background: var(--soft);
		border-left: 3px solid var(--accent);
	}
	.notice.error {
		background: color-mix(in srgb, var(--coral) 18%, var(--paper));
		border-color: var(--coral);
	}
	.campaign-layout {
		display: grid;
		grid-template-columns: minmax(180px, 250px) minmax(0, 1fr);
		gap: 1rem;
		align-items: start;
	}
	.campaign-list {
		display: grid;
		gap: 0.4rem;
	}
	.campaign-list button {
		text-align: left;
		border: 1px solid var(--line);
		padding: 0.75rem;
		background: var(--white);
		color: var(--ink);
	}
	.campaign-list button.current {
		border-color: var(--accent);
		box-shadow: inset 3px 0 var(--accent);
	}
	.campaign-list strong,
	.campaign-list span {
		display: block;
	}
	.campaign-list span {
		color: var(--muted);
		font-size: 0.75rem;
		margin-top: 0.2rem;
	}
	.editor {
		border: 1px solid var(--line);
		background: var(--white);
		padding: clamp(0.9rem, 2vw, 1.4rem);
		display: grid;
		gap: 1.2rem;
		min-width: 0;
	}
	.editor-title {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 1rem;
		border-bottom: 1px solid var(--line);
		padding-bottom: 0.8rem;
	}
	.editor-title h3 {
		margin: 0.2rem 0;
	}
	.save-state {
		display: flex;
		align-items: center;
		gap: 0.35rem;
		color: var(--muted);
		font-size: 0.78rem;
	}
	.form-grid {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 0.8rem;
	}
	.form-grid label,
	.subpanel label,
	.fund-grid label {
		display: grid;
		gap: 0.35rem;
		font-size: 0.8rem;
		color: var(--muted);
	}
	.form-grid .wide {
		grid-column: 1/-1;
	}
	.form-grid input,
	.form-grid textarea,
	.form-grid select,
	.subpanel input,
	.subpanel textarea,
	.subpanel select,
	.fund-grid input {
		width: 100%;
		padding: 0.65rem;
		border: 1px solid var(--line);
		background: var(--paper);
		color: var(--ink);
		font: inherit;
		min-height: 43px;
	}
	.form-grid small {
		font-size: 0.72rem;
		color: var(--muted);
	}
	.settings,
	.fund-admin {
		border-top: 1px solid var(--line);
		padding-top: 0.9rem;
	}
	.settings summary,
	.fund-admin summary {
		font-weight: 600;
		display: flex;
		align-items: center;
		gap: 0.45rem;
		cursor: pointer;
		min-height: 44px;
	}
	.checks {
		grid-column: 1/-1;
		display: flex;
		flex-wrap: wrap;
		gap: 1rem;
	}
	.checks label {
		display: flex;
		align-items: center;
		gap: 0.35rem;
	}
	.actions {
		display: flex;
		align-items: center;
		gap: 0.65rem;
		flex-wrap: wrap;
	}
	.text-link,
	.quiet {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
		color: var(--accent);
		background: transparent;
		border: 0;
		text-decoration: underline;
		font: inherit;
		padding: 0.5rem;
	}
	.publish-preview {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		border: 1px solid var(--line);
		padding: 1rem;
		background: var(--soft);
	}
	.publish-preview h3 {
		margin: 0.25rem 0;
	}
	.publish-preview p {
		margin: 0.25rem 0;
		color: var(--muted);
	}
	.publish-preview small {
		display: block;
		color: var(--muted);
		margin-top: 0.35rem;
	}
	.publish-preview img {
		width: 150px;
		max-height: 110px;
		object-fit: cover;
	}
	.field-title {
		font-size: 0.8rem;
		color: var(--muted);
		margin: 0;
	}
	.version-list {
		list-style: none;
		padding: 0;
	}
	.version-list li,
	.resource-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.7rem;
		padding: 0.55rem 0;
		border-bottom: 1px solid var(--line);
		font-size: 0.8rem;
	}
	.version-list span,
	.resource-row span {
		color: var(--muted);
	}
	.management-grid {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 0.8rem;
	}
	.subpanel {
		border: 1px solid var(--line);
		padding: 1rem;
		min-width: 0;
	}
	.subpanel h3 {
		display: flex;
		align-items: center;
		gap: 0.45rem;
		margin-bottom: 0.75rem;
	}
	.subpanel form {
		display: grid;
		gap: 0.65rem;
	}
	.subpanel .secondary {
		width: 100%;
	}
	.variant-preview {
		border-top: 1px solid var(--line);
		margin-top: 0.8rem;
		padding-top: 0.65rem;
	}
	.variant-preview p,
	.subpanel > p {
		color: var(--muted);
		font-size: 0.8rem;
	}
	.link-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
		border-top: 1px solid var(--line);
		padding: 0.7rem 0;
	}
	.link-row > div {
		min-width: 0;
		display: grid;
		gap: 0.2rem;
	}
	.link-row a {
		overflow-wrap: anywhere;
		color: var(--accent);
		font-size: 0.76rem;
	}
	.link-row small {
		color: var(--muted);
	}
	.link-row img {
		width: 92px;
		height: 92px;
		object-fit: contain;
		background: white;
	}
	.empty {
		padding: 2rem;
		text-align: center;
		border: 1px dashed var(--line);
		display: grid;
		justify-items: center;
		gap: 1rem;
	}
	.fund-grid {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 1rem;
	}
	.fund-grid form {
		display: grid;
		gap: 0.65rem;
		padding: 1rem;
		border: 1px solid var(--line);
	}
	@media (max-width: 900px) {
		.campaign-layout {
			grid-template-columns: 1fr;
		}
		.campaign-list {
			display: flex;
			overflow-x: auto;
		}
		.campaign-list button {
			min-width: 170px;
		}
		.management-grid {
			grid-template-columns: 1fr;
		}
	}
	@media (max-width: 580px) {
		.builder-head {
			align-items: flex-start;
			flex-direction: column;
		}
		.form-grid,
		.fund-grid {
			grid-template-columns: 1fr;
		}
		.checks {
			display: grid;
		}
		.editor-title {
			align-items: flex-start;
			flex-direction: column;
		}
		.publish-preview {
			align-items: flex-start;
			flex-direction: column;
		}
		.publish-preview img {
			width: 100%;
		}
		.actions > * {
			flex: 1 1 auto;
		}
	}
</style>
