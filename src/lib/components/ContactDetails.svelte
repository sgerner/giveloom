<script lang="ts">
	import { onMount } from 'svelte';
	import {
		Plus,
		Mail,
		Phone,
		MapPin,
		ShieldCheck,
		FileText,
		Download,
		Trash2,
		Check
	} from 'lucide-svelte';
	let {
		tenant,
		contactId,
		onChanged = () => {}
	} = $props<{ tenant: string; contactId?: string; onChanged?: () => void }>();
	let data = $state<any>({
			methods: [],
			addresses: [],
			consents: [],
			fields: [],
			values: [],
			notes: []
		}),
		loading = $state(true),
		pending = $state(false),
		error = $state(''),
		saved = $state(''),
		action = $state('method'),
		form = $state<Record<string, any>>({ kind: 'email' }),
		confirmPrivacy = $state(false);
	async function load() {
		loading = true;
		try {
			const r = await fetch('/api/v1/crm' + (contactId ? '?contactId=' + contactId : ''));
			const v = await r.json();
			if (!r.ok) throw new Error(v.error);
			data = v;
		} catch (e) {
			error = e instanceof Error ? e.message : 'Details unavailable';
		} finally {
			loading = false;
		}
	}
	onMount(() => {
		if (!contactId) changeAction('field');
		load();
	});
	async function save(payload?: Record<string, any>) {
		pending = true;
		error = '';
		saved = '';
		try {
			let body = payload || { ...form, action, ...(contactId ? { contactId } : {}) };
			if (action === 'field' && !payload) {
				body.choices = String(body.choiceText || '')
					.split(',')
					.map((s) => s.trim())
					.filter(Boolean);
				delete body.choiceText;
			}
			const r = await fetch('/api/v1/crm', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body)
			});
			const v = await r.json();
			if (!r.ok) throw new Error(v.error);
			if (body.action === 'privacy' && body.operation === 'export') {
				const url = URL.createObjectURL(
					new Blob([JSON.stringify(v.result, null, 2)], { type: 'application/json' })
				);
				const a = document.createElement('a');
				a.href = url;
				a.download = 'contact-privacy-export.json';
				a.click();
				URL.revokeObjectURL(url);
			}
			saved =
				body.action === 'privacy' && body.operation === 'anonymize'
					? 'Profile anonymized; financial retention records remain.'
					: 'Saved with an audit record.';
			changeAction(action);
			confirmPrivacy = false;
			await load();
			onChanged();
		} catch (e) {
			error = e instanceof Error ? e.message : 'Save failed';
		} finally {
			pending = false;
		}
	}
	function changeAction(value: string) {
		action = value;
		form =
			value === 'consent'
				? { channel: 'email', purpose: 'marketing', status: 'granted', lawfulBasis: 'consent' }
				: value === 'field'
					? { kind: 'text' }
					: value === 'address'
						? { country: 'US', label: 'home' }
						: { kind: 'email' };
	}
	function fieldValue(id: string) {
		return data.values.find((v: any) => v.fieldId === id)?.value ?? '';
	}
</script>

<section class="contact-details">
	{#if error}<p class="banner error" role="alert">{error}</p>{/if}{#if saved}<p
			class="banner success"
			role="status"
		>
			{saved}
		</p>{/if}
	{#if loading}<p aria-busy="true">Gathering the little details…</p>{:else}
		<div class="detail-columns">
			<div>
				{#if contactId}<h2>The ways to stay in touch</h2>
					{#each data.methods as method}<div class="detail-line">
							{#if method.kind === 'email'}<Mail size={17} />{:else}<Phone size={17} />{/if}<span
								>{method.value}</span
							>{#if method.preferred}<span class="pill">Preferred</span>{/if}
						</div>{:else}<p class="muted small">
							Add additional email addresses and phone numbers.
						</p>{/each}
					{#each data.addresses as address}<div class="detail-line">
							<MapPin size={18} />
							<p>
								{address.label} · {address.line1}<br />{address.city}, {address.region}
								{address.postalCode} · {address.country}
							</p>
						</div>{/each}
					<h3 class="subheading">Consent, with a clear trail</h3>
					{#each data.consents as consent}<div class="consent-line">
							<span class="pill">{consent.status}</span>
							<div>
								<strong>{consent.channel} · {consent.purpose}</strong>
								<p>
									{consent.source} · {new Date(
										consent.recordedAt || consent.createdAt
									).toLocaleString()} · {consent.lawfulBasis}
								</p>
							</div>
						</div>{:else}<p class="muted small">No documented consent has been recorded.</p>{/each}
					<h3 class="subheading">Thoughtful notes</h3>
					{#each data.notes as note}<article class="note-entry">
							<p>{note.body}</p>
							<small
								>{note.sensitive ? 'Restricted · ' : ''}{new Date(
									note.createdAt
								).toLocaleString()}</small
							>
						</article>{:else}<p class="muted small">
							A conversation is worth remembering.
						</p>{/each}{/if}
				<h3 class="subheading">Your custom fields</h3>
				{#each data.fields as field}<form
						class="custom-value"
						onsubmit={(e) => {
							e.preventDefault();
							const el = e.currentTarget.elements.namedItem('value') as
								HTMLInputElement | HTMLSelectElement;
							save({
								action: 'value',
								contactId,
								fieldId: field.id,
								value:
									field.kind === 'number'
										? Number(el.value)
										: field.kind === 'boolean'
											? (el as HTMLInputElement).checked
											: el.value
							});
						}}
					>
						<label
							>{field.name}
							{#if field.sensitive}<span class="pill">Restricted</span>{/if}
							{#if contactId}{#if field.kind === 'choice'}<select
										name="value"
										value={fieldValue(field.id)}
										required={field.required}
										><option value="">Choose…</option>{#each field.choices || [] as choice}<option
												>{choice}</option
											>{/each}</select
									>{:else if field.kind === 'boolean'}<input
										name="value"
										type="checkbox"
										checked={Boolean(fieldValue(field.id))}
									/>{:else}<input
										name="value"
										type={field.kind === 'date'
											? 'date'
											: field.kind === 'number'
												? 'number'
												: 'text'}
										value={fieldValue(field.id)}
										required={field.required}
									/>{/if}{/if}</label
						>{#if contactId}<button
								class="icon-button"
								aria-label={'Save ' + field.name}
								disabled={pending}><Check size={17} /></button
							>{/if}
					</form>{:else}<p class="muted small">
						Define the details that matter to your organization.
					</p>{/each}
			</div>
			<aside>
				<h2>{contactId ? 'Add a little context' : 'Define a custom field'}</h2>
				<div class="tabs detail-tabs">
					{#each contactId ? ['method', 'address', 'consent', 'note', 'field'] : ['field'] as type}<button
							class:chosen={action === type}
							onclick={() => changeAction(type)}>{type}</button
						>{/each}
				</div>
				<form
					class="stacked-form"
					onsubmit={(e) => {
						e.preventDefault();
						save();
					}}
				>
					{#if action === 'method' && contactId}<label
							>Contact method<select bind:value={form.kind}
								><option value="email">Email</option><option value="phone">Phone</option></select
							></label
						><label
							>Value<input
								required
								type={form.kind === 'email' ? 'email' : 'tel'}
								bind:value={form.value}
							/></label
						><label class="checkbox-label"
							><input type="checkbox" bind:checked={form.preferred} />Preferred for this channel</label
						>
					{:else if action === 'address' && contactId}<label
							>Street address<input required bind:value={form.line1} /></label
						><label>Address line 2<input bind:value={form.line2} /></label>
						<div class="field-pair">
							<label>City<input bind:value={form.city} /></label><label
								>State / region<input bind:value={form.region} /></label
							>
						</div>
						<div class="field-pair">
							<label>Postal code<input bind:value={form.postalCode} /></label><label
								>Country code<input
									maxlength="2"
									bind:value={form.country}
									placeholder="US"
								/></label
							>
						</div>
						<label class="checkbox-label"
							><input type="checkbox" bind:checked={form.preferred} />Preferred postal address</label
						>
					{:else if action === 'consent' && contactId}<div class="field-pair">
							<label
								>Channel<select bind:value={form.channel}
									><option>email</option><option>phone</option><option>sms</option><option
										>post</option
									></select
								></label
							><label
								>Purpose<select bind:value={form.purpose}
									><option>marketing</option><option>receipts</option><option>research</option
									></select
								></label
							>
						</div>
						<label
							>Status<select bind:value={form.status}
								><option value="granted">Granted</option><option value="withdrawn">Withdrawn</option
								><option value="unknown">Unknown</option></select
							></label
						><label
							>Source / evidence<input
								required
								bind:value={form.source}
								placeholder="Donor confirmed at meeting, signed form…"
							/></label
						><label
							>Lawful basis<select bind:value={form.lawfulBasis}
								><option value="consent">Consent</option><option value="legitimate_interest"
									>Legitimate interest</option
								><option value="contract">Contract</option><option value="legal_obligation"
									>Legal obligation</option
								></select
							></label
						>
						<p class="muted small">
							Withdrawing email marketing consent suppresses future marketing sends, including
							automations.
						</p>
					{:else if action === 'note' && contactId}<label
							>Note<textarea required rows="5" bind:value={form.body}></textarea></label
						><label class="checkbox-label"
							><input type="checkbox" bind:checked={form.sensitive} />Restricted note (owner/admin
							only)</label
						>
					{:else}<label>Field name<input required maxlength="80" bind:value={form.name} /></label
						><label
							>Field type<select bind:value={form.kind}
								><option value="text">Text</option><option value="number">Number</option><option
									value="date">Date</option
								><option value="boolean">Yes / no</option><option value="choice">Choice</option
								></select
							></label
						>{#if form.kind === 'choice'}<label
								>Choices, comma separated<input required bind:value={form.choiceText} /></label
							>{/if}<label class="checkbox-label"
							><input type="checkbox" bind:checked={form.sensitive} />Restricted field</label
						><label class="checkbox-label"
							><input type="checkbox" bind:checked={form.required} />Required field</label
						>
						<p class="muted small">
							Custom field definitions require an owner or administrator.
						</p>{/if}
					<button class="primary" disabled={pending}
						><Plus size={16} />{pending
							? 'Saving…'
							: 'Save ' + (contactId ? action : 'field')}</button
					>
				</form>
				{#if contactId}<details class="privacy-controls">
						<summary><ShieldCheck size={17} /> Privacy & retention</summary>
						<p>
							Export the donor’s profile or anonymize personal details. Financial ledger, receipt
							snapshots, and required audit records are retained.
						</p>
						<label>Reason<input bind:value={form.privacyReason} /></label><label
							class="checkbox-label"
							><input type="checkbox" bind:checked={confirmPrivacy} />I reviewed the identity and
							retention impact.</label
						>
						<div class="button-group">
							<button
								class="secondary"
								disabled={!confirmPrivacy || !form.privacyReason || pending}
								onclick={() =>
									save({
										action: 'privacy',
										operation: 'export',
										contactId,
										confirmed: true,
										reason: form.privacyReason
									})}><Download size={15} />Export</button
							><button
								class="secondary"
								disabled={!confirmPrivacy || !form.privacyReason || pending}
								onclick={() =>
									save({
										action: 'privacy',
										operation: 'anonymize',
										contactId,
										confirmed: true,
										reason: form.privacyReason
									})}><Trash2 size={15} />Anonymize</button
							>
						</div>
					</details>{/if}
			</aside>
		</div>{/if}
</section>

<style>
	.contact-details {
		padding: 20px 0;
	}
	.detail-columns {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 45px;
	}
	.detail-columns h2 {
		margin-bottom: 24px;
	}
	.detail-line {
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 14px 0;
		border-bottom: 1px solid var(--line);
		font-size: 12px;
	}
	.subheading {
		margin: 30px 0 16px;
	}
	.consent-line {
		display: flex;
		gap: 12px;
		padding: 14px 0;
		border-bottom: 1px solid var(--line);
	}
	.consent-line strong {
		font-size: 11px;
		font-weight: 500;
	}
	.consent-line p {
		font-size: 10px;
		color: var(--muted);
		margin-top: 4px;
	}
	.note-entry {
		border-left: 2px solid var(--line);
		padding: 12px 15px;
		margin: 14px 0;
		font-size: 13px;
	}
	.note-entry small {
		display: block;
		margin-top: 10px;
		color: var(--muted);
		font-size: 10px;
	}
	.custom-value {
		display: flex;
		align-items: flex-end;
		gap: 12px;
		margin: 17px 0;
	}
	.custom-value > label {
		flex: 1;
	}
	.detail-tabs {
		gap: 17px;
	}
	.detail-tabs button {
		text-transform: capitalize;
	}
	.privacy-controls {
		border-top: 1px solid var(--line);
		margin-top: 30px;
		padding-top: 20px;
		font-size: 12px;
	}
	.privacy-controls summary {
		cursor: pointer;
		display: flex;
		gap: 9px;
		align-items: center;
	}
	.privacy-controls p {
		color: var(--muted);
		margin: 15px 0;
	}
	.privacy-controls .button-group {
		margin-top: 15px;
	}
	@media (max-width: 760px) {
		.detail-columns {
			grid-template-columns: 1fr;
			gap: 30px;
		}
	}
</style>
