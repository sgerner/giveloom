<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { fade, fly } from 'svelte/transition';
	import {
		ArrowUpRight,
		ArrowRight,
		Plus,
		Search,
		Bell,
		ChevronDown,
		LayoutDashboard,
		Users,
		Heart,
		Compass,
		Network,
		Mail,
		Workflow,
		ChartNoAxesCombined,
		Settings,
		Check,
		X,
		SlidersHorizontal,
		MoreHorizontal,
		CircleHelp,
		LogOut,
		Menu,
		Download,
		Calendar,
		Sparkles,
		Leaf,
		ArrowLeft,
		CheckCircle2,
		ExternalLink,
		Circle,
		Sun,
		Moon,
		Monitor,
		Upload,
		FileText,
		Send
	} from 'lucide-svelte';
	import CollectionDirectory from '$lib/components/CollectionDirectory.svelte';
	import ContactPicker from '$lib/components/ContactPicker.svelte';
	import ContactDirectory from '$lib/components/ContactDirectory.svelte';
	import ProspectWorkbench from '$lib/components/ProspectWorkbench.svelte';
	import IntelligenceExplorer from '$lib/components/IntelligenceExplorer.svelte';
	import ReportsExplorer from '$lib/components/ReportsExplorer.svelte';
	import AdminConsole from '$lib/components/AdminConsole.svelte';
	import ContactTimeline from '$lib/components/ContactTimeline.svelte';
	import { formatMoney, majorToMinor, minorToMajor } from '$lib/money';
	import NotificationInbox from '$lib/components/NotificationInbox.svelte';
	import SenderDiagnostics from '$lib/components/SenderDiagnostics.svelte';
	import BrandingSettings from '$lib/components/BrandingSettings.svelte';
	import OnboardingChecklist from '$lib/components/OnboardingChecklist.svelte';
	import Chart from '$lib/components/Chart.svelte';
	import ContactDetails from '$lib/components/ContactDetails.svelte';
	import GivingManager from '$lib/components/GivingManager.svelte';
	import CampaignBuilder from '$lib/components/CampaignBuilder.svelte';
	import EventManager from '$lib/components/EventManager.svelte';
	import IdentitySettings from '$lib/components/IdentitySettings.svelte';
	import AutomationEditor from '$lib/components/AutomationEditor.svelte';
	import Stewardship from '$lib/components/Stewardship.svelte';
	import JobMonitor from '$lib/components/JobMonitor.svelte';
	import EmailStudio from '$lib/components/EmailStudio.svelte';
	import Assistant from '$lib/components/Assistant.svelte';
	import { ledgerReport, donorRetention, type GiftRow } from '$lib/reporting';
	import { canonicalContactId } from '$lib/identity';
	import { themes } from '$lib/themes';
	import { focusTrap } from '$lib/focus-trap';
	import type { Workspace, Entity } from '$lib/types';
	let workspace = $state<Workspace | null>(null);
	let workspaceLoadId = 0;
	let tenantSwitching = $state(false);
	let loading = $state(true),
		error = $state(''),
		feedback = $state(''),
		saving = $state(false);
	let search = $state(''),
		filter = $state('all'),
		sort = $state('name'),
		currentPage = $state(1);
	let modal = $state(''),
		editId = $state(''),
		command = $state(false),
		commandQuery = $state(''),
		mobileNav = $state(false),
		notifications = $state(false);
	let form = $state<Record<string, any>>({});
	let mergeTarget = $state(''),
		mergePreview = $state<any>(null),
		lastMerge = $state<any>(null),
		emailPreview = $state<any>(null),
		sendApproved = $state(false);
	let reportFrom = $state(''),
		reportTo = $state(''),
		reportCampaign = $state('');
	let greeting = $state('');
	let theme = $state('donor-crm'),
		mode = $state('system'),
		profileTab = $state('Activity'),
		simulation = $state('');
	let receipts = $state<Entity[]>([]),
		receiptError = $state('');
	let files = $state<Entity[]>([]),
		fileError = $state(''),
		fileUploading = $state(false),
		auditItems = $state<Entity[]>([]);
	let importText = $state(''),
		importResult = $state<any>(null);
	let stripeStatus = $state<any>(null);
	let aiPrompt = $state(''),
		aiResponse = $state('');
	let pathFrom = $state(''),
		pathTo = $state(''),
		pathDepth = $state(2),
		pathResults = $state<any>(null);
	let researchXml = $state(''),
		researchSource = $state(''),
		researchResult = $state<any>(null);
	let integrationConfigs = $state<any[]>([]);
	let providerForm = $state<Record<string, any>>({
		provider: 'openai',
		model: 'gpt-4.1-mini',
		enabled: false
	});
	let section = $derived(page.params.section?.split('/')[0] || 'overview');
	let detailId = $derived(page.params.section?.split('/')[1] || '');
	let tenant = $derived(page.params.tenant || 'riverstone');
	let base = $derived('/app/' + tenant);
	const navigation = [
		{ label: 'Overview', path: 'overview', icon: LayoutDashboard },
		{ label: 'People', path: 'contacts', icon: Users },
		{ label: 'Giving', path: 'gifts', icon: Heart },
		{ label: 'Discover', path: 'prospects', icon: Compass },
		{ label: 'Relationships', path: 'relationships', icon: Network },
		{ label: 'Outreach', path: 'email', icon: Mail },
		{ label: 'Workflows', path: 'automations', icon: Workflow },
		{ label: 'Insights', path: 'reports', icon: ChartNoAxesCombined }
	];
	const money = (amount: number, currency = workspace?.tenant.currency || 'USD') =>
		formatMoney(amount || 0, currency);
	const date = (value: string) =>
		value
			? new Date(value.length === 10 ? value + 'T12:00:00Z' : value).toLocaleDateString('en-US', {
					month: 'short',
					day: 'numeric',
					timeZone: workspace?.tenant.timeZone || 'America/Phoenix'
				})
			: '—';
	const initials = (name: string) =>
		(name || '?')
			.split(' ')
			.map((x) => x[0])
			.slice(0, 2)
			.join('');
	const canonical = (id: string) => canonicalContactId(id, workspace?.contactAliases || []);
	const contactName = (id: string) =>
		workspace?.contacts.find((x) => x.id === canonical(id))?.name ||
		workspace?.contactAliases?.find((x) => x.id === id)?.name ||
		'Unassigned';
	const campaignName = (id: string) =>
		workspace?.campaigns.find((x) => x.id === id)?.name || 'General fund';
	const prospectName = (id: string) =>
		workspace?.prospects.find((x) => x.id === id)?.name || 'Unassigned prospect';
	let totalGiving = $derived(
		workspace?.overview?.grossMinor ??
			ledgerReport((workspace?.gifts || []) as GiftRow[], {
				currency: workspace?.tenant.currency || 'USD'
			}).grossMinor
	);
	let reportData = $derived(
		ledgerReport((workspace?.gifts || []) as GiftRow[], {
			currency: workspace?.tenant.currency || 'USD',
			from: reportFrom || undefined,
			to: reportTo || undefined,
			campaignId: reportCampaign || undefined
		})
	);
	let retention = $derived(
		donorRetention(
			(workspace?.gifts || []).map((g) => ({
				...g,
				contactId: canonical(g.contactId)
			})) as GiftRow[],
			new Date().getUTCFullYear()
		)
	);
	let openTasks = $derived(workspace?.tasks.filter((x) => x.status !== 'completed') || []);
	let recurring = $derived(
		workspace?.overview?.recurringMinor ??
			(workspace?.gifts
				.filter((x) => x.kind === 'recurring' && x.status === 'recorded')
				.reduce((a, x) => a + x.amountMinor, 0) ||
				0)
	);
	let currentContact = $derived(workspace?.contacts.find((x) => x.id === detailId));
	let currentCampaign = $derived(workspace?.campaigns.find((x) => x.id === detailId));
	let currentEmail = $derived(workspace?.emails.find((x) => x.id === detailId));
	let currentAutomation = $derived(workspace?.automations.find((x) => x.id === detailId));
	let currentProspect = $derived(workspace?.prospects.find((x) => x.id === detailId));
	const chartMonths = Array.from({ length: 6 }, (_, i) => {
		const date = new Date();
		date.setUTCDate(1);
		date.setUTCMonth(date.getUTCMonth() - 5 + i);
		return {
			key: date.toISOString().slice(0, 7),
			label: date.toLocaleDateString(undefined, { month: 'short', timeZone: 'UTC' })
		};
	});
	const chartPeriod =
		chartMonths[0].label + ' – ' + chartMonths[5].label + ' ' + new Date().getUTCFullYear();
	let chartValues = $derived(
		chartMonths.map((month) =>
			workspace?.overview
				? Number(
						workspace.overview.byMonth.find((m: any) => m.month === month.key)?.amountMinor || 0
					)
				: (workspace?.gifts || [])
						.filter(
							(g) =>
								String(g.occurredAt || g.createdAt).startsWith(month.key) &&
								g.currency === workspace?.tenant.currency &&
								g.status === 'recorded' &&
								!['correction', 'pledge'].includes(g.kind)
						)
						.reduce((n, g) => n + g.amountMinor, 0)
		)
	);
	let householdMemberToAdd = $state('');
	let contactSummaries = $state<Record<string, any[]>>({});
	let workspaceRevision = $state(0);
	$effect(() => {
		const id = detailId,
			slug = tenant;
		if (section !== 'contacts' || !id || !workspaceRevision) return;
		let cancelled = false;
		void fetch('/api/v1/contacts/' + encodeURIComponent(id))
			.then(async (r) => {
				const data = await r.json();
				if (!r.ok) throw new Error(data.error || 'Contact unavailable.');
				if (cancelled) return;
				contactSummaries = { ...contactSummaries, [id]: data.givingByCurrency || [] };
				if (workspace)
					workspace = {
						...workspace,
						contacts: [...workspace.contacts.filter((c) => c.id !== id), data.contact],
						contactAliases: [
							...(workspace.contactAliases || []),
							...(data.aliases || []).map((a: any) => ({ ...a, mergedInto: id }))
						]
					};
			})
			.catch((e) => {
				if (!cancelled) error = e.message;
			});
		return () => {
			cancelled = true;
		};
	});

	let reportChartValues = $derived(
		Array.from({ length: 6 }, (_, i) =>
			reportData.rows
				.filter(
					(g) =>
						new Date(g.occurredAt || g.createdAt || '').getUTCMonth() === i + 4 &&
						g.status === 'recorded' &&
						!['correction', 'pledge'].includes(g.kind)
				)
				.reduce((a, g) => a + g.amountMinor, 0)
		)
	);
	let filteredContacts = $derived(
		(workspace?.contacts || [])
			.filter(
				(c) =>
					!c.archived &&
					[c.name, c.email, ...(c.tags || [])]
						.join(' ')
						.toLowerCase()
						.includes(search.toLowerCase()) &&
					(filter === 'all' || c.stage === filter)
			)
			.sort((a, b) =>
				sort === 'giving'
					? givingFor(b.id) - givingFor(a.id)
					: String(a.name).localeCompare(String(b.name))
			)
	);
	let contactPages = $derived(Math.max(1, Math.ceil(filteredContacts.length / 10)));
	let shownContacts = $derived(filteredContacts.slice((currentPage - 1) * 10, currentPage * 10));
	let searchResults = $state<{ id?: string; name: string; kind: string; url: string }[]>([]),
		commandError = $state('');
	$effect(() => {
		const q = commandQuery,
			active = command,
			slug = tenant;
		if (!active) return;
		let cancelled = false;
		const timer = setTimeout(async () => {
			commandError = '';
			try {
				const r = await fetch('/api/v1/search?' + new URLSearchParams({ tenant: slug, q }));
				const body = await r.json();
				if (!r.ok) throw new Error(body.error || 'Search unavailable.');
				if (!cancelled) searchResults = body.items || [];
			} catch (e) {
				if (!cancelled) commandError = e instanceof Error ? e.message : 'Search unavailable.';
			}
		}, 180);
		return () => {
			cancelled = true;
			clearTimeout(timer);
		};
	});

	function givingFor(id: string) {
		if (contactSummaries[id])
			return Number(
				contactSummaries[id].find((s) => s.currency.trim() === workspace?.tenant.currency)
					?.grossMinor || 0
			);
		return (
			workspace?.gifts
				.filter(
					(g) =>
						canonical(g.contactId) === id &&
						g.status === 'recorded' &&
						!['correction', 'pledge'].includes(g.kind)
				)
				.reduce((a, g) => a + g.amountMinor, 0) || 0
		);
	}
	function campaignGiving(id: string) {
		if (workspace?.overview) return Number(workspace.overview.campaignGiving[id] || 0);
		return (
			workspace?.gifts
				.filter(
					(g) =>
						g.campaignId === id &&
						g.status === 'recorded' &&
						!['correction', 'pledge'].includes(g.kind)
				)
				.reduce((a, g) => a + g.amountMinor, 0) || 0
		);
	}
	async function load() {
		const requestedTenant = tenant;
		const requestId = ++workspaceLoadId;
		const isCurrent = () => requestId === workspaceLoadId && requestedTenant === tenant;
		loading = !workspace || workspace.tenant.slug !== requestedTenant;
		error = '';
		try {
			const res = await fetch(
				'/api/v1/workspace?compact=true&tenant=' + encodeURIComponent(requestedTenant)
			);
			if (!isCurrent()) return;
			if (res.status === 401) {
				await goto('/');
				return;
			}
			const body = await res.json();
			if (!isCurrent()) return;
			if (res.status === 403) workspace = null;
			if (!res.ok) throw new Error(body.error || 'Workspace could not be loaded.');
			workspace = body;
			workspaceRevision += 1;
			localStorage.setItem('crm-recent-tenant', requestedTenant);
			const prefResponse = await fetch('/api/v1/preferences');
			if (!isCurrent()) return;
			if (prefResponse.ok) {
				const prefs = (await prefResponse.json()).preferences;
				greeting = prefs.greeting || '';
				if (prefs.theme && (prefs.theme === 'donor-crm' || themes.includes(prefs.theme)))
					theme = prefs.theme;
				if (['light', 'dark', 'system'].includes(prefs.mode)) mode = prefs.mode;
				applyAppearance();
			}
			fetch('/api/v1/integrations')
				.then((r) => (r.ok ? r.json() : null))
				.then((result) => {
					if (result && isCurrent()) integrationConfigs = result.providers || [];
				})
				.catch(() => {});
		} catch (e) {
			if (isCurrent()) error = e instanceof Error ? e.message : 'Unable to load workspace';
		} finally {
			if (isCurrent()) loading = false;
		}
	}
	onMount(() => {
		load();
		theme = localStorage.getItem('crm-theme') || 'donor-crm';
		mode = localStorage.getItem('crm-mode') || 'system';
		applyAppearance();
		const media = matchMedia('(prefers-color-scheme: dark)');
		media.addEventListener('change', applyTheme);
		return () => media.removeEventListener('change', applyTheme);
	});
	function applyAppearance() {
		document.documentElement.dataset.theme = theme;
		document.documentElement.classList.toggle(
			'dark',
			mode === 'dark' || (mode === 'system' && matchMedia('(prefers-color-scheme: dark)').matches)
		);
		localStorage.setItem('crm-theme', theme);
		localStorage.setItem('crm-mode', mode);
	}
	function applyTheme() {
		applyAppearance();
		void fetch('/api/v1/preferences', {
			method: 'PATCH',
			keepalive: true,
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ theme, mode })
		})
			.then(async (r) => {
				if (!r.ok) error = 'Appearance saved on this device; account preference sync failed.';
			})
			.catch(() => (error = 'Appearance saved on this device; account preference sync failed.'));
	}

	async function changeTenant(event: Event) {
		if (tenantSwitching) return;
		const control = event.target as HTMLSelectElement;
		const slug = control.value;
		tenantSwitching = true;
		++workspaceLoadId;
		loading = true;
		try {
			const res = await fetch(workspace?.tenant.demo ? '/api/v1/demo' : '/api/v1/session/switch', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ tenant: slug })
			});
			if (res.ok) {
				integrationConfigs = [];
				contactSummaries = {};
				localStorage.setItem('crm-recent-tenant', slug);
				await goto('/app/' + slug + '/overview');
				await load();
			} else {
				error = 'Tenant switching is unavailable for this account.';
				loading = false;
			}
		} catch {
			error = 'Tenant switching is unavailable. Try again.';
			loading = false;
		} finally {
			tenantSwitching = false;
			control.value = tenant;
		}
	}

	async function previewMerge() {
		error = '';
		saving = true;
		try {
			const res = await fetch('/api/v1/contacts/merge/preview', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ tenant, sourceContactId: detailId, targetContactId: mergeTarget })
			});
			const body = await res.json();
			if (!res.ok) throw new Error(body.error);
			mergePreview = body;
		} catch (e) {
			error = e instanceof Error ? e.message : 'Merge preview failed';
		} finally {
			saving = false;
		}
	}
	async function commitMerge() {
		error = '';
		saving = true;
		try {
			const res = await fetch('/api/v1/contacts/merge', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ tenant, sourceContactId: detailId, targetContactId: mergeTarget })
			});
			const body = await res.json();
			if (!res.ok) throw new Error(body.error);
			lastMerge = body;
			modal = '';
			await load();
			await goto(base + '/contacts/' + body.targetId);
			feedback = 'Contacts merged. Gift history retains its original record references.';
		} catch (e) {
			error = e instanceof Error ? e.message : 'Merge failed';
		} finally {
			saving = false;
		}
	}
	async function undoMerge() {
		if (!lastMerge) return;
		saving = true;
		error = '';
		try {
			const res = await fetch('/api/v1/contacts/merge/undo', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ tenant, mergeId: lastMerge.mergeId })
			});
			const body = await res.json();
			if (!res.ok) throw new Error(body.error);
			lastMerge = null;
			await load();
			feedback = 'Merge undone. Original contact records restored.';
		} catch (e) {
			error = e instanceof Error ? e.message : 'Undo failed';
		} finally {
			saving = false;
		}
	}
	async function previewSend() {
		error = '';
		saving = true;
		try {
			const res = await fetch('/api/v1/email/preview', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ emailId: detailId })
			});
			const body = await res.json();
			if (!res.ok) throw new Error(body.error);
			emailPreview = body;
			sendApproved = false;
			modal = 'send-preview';
		} catch (e) {
			error = e instanceof Error ? e.message : 'Send preview unavailable';
		} finally {
			saving = false;
		}
	}
	async function approveSend() {
		error = '';
		saving = true;
		try {
			const res = await fetch('/api/v1/email/send', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ previewToken: emailPreview.previewToken, approved: sendApproved })
			});
			const body = await res.json();
			if (!res.ok) throw new Error(body.error);
			modal = '';
			feedback = body.queued + ' messages queued. Queuing is not confirmation of delivery.';
			await load();
		} catch (e) {
			error = e instanceof Error ? e.message : 'Send could not be queued';
		} finally {
			saving = false;
		}
	}
	async function getStripeStatus() {
		if (workspace?.tenant.demo) {
			stripeStatus = { connected: false };
			return;
		}
		const res = await fetch('/api/v1/payments/connect');
		if (res.ok) stripeStatus = await res.json();
		else error = 'Stripe status is unavailable.';
	}
	async function downloadReport() {
		const query = new URLSearchParams({
			tenant,
			format: 'csv',
			currency: workspace?.tenant.currency || 'USD',
			...(reportFrom ? { from: reportFrom } : {}),
			...(reportTo ? { to: reportTo } : {}),
			...(reportCampaign ? { campaignId: reportCampaign } : {})
		});
		const response = await fetch('/api/v1/reports/giving?' + query);
		if (!response.ok) {
			const result = await response.json();
			error = result.error || 'Report export failed.';
			return;
		}
		const url = URL.createObjectURL(await response.blob());
		const link = document.createElement('a');
		link.href = url;
		link.download = 'giving-ledger.csv';
		link.click();
		URL.revokeObjectURL(url);
		modal = '';
	}
	async function loadReceipts() {
		receiptError = '';
		try {
			const res = await fetch('/api/v1/receipts?contactId=' + detailId);
			const result = await res.json();
			if (!res.ok) throw new Error(result.error || 'Receipts unavailable');
			receipts = result.receipts || [];
		} catch (e) {
			receiptError = e instanceof Error ? e.message : 'Receipts unavailable';
		}
	}
	async function loadFiles() {
		fileError = '';
		try {
			const res = await fetch('/api/v1/files?contactId=' + detailId);
			const result = await res.json();
			if (!res.ok) throw new Error(result.error || 'Files are unavailable');
			files = result.items || result.files || [];
		} catch (e) {
			fileError = e instanceof Error ? e.message : 'Files unavailable';
		}
	}
	async function uploadFile(event: Event) {
		const input = event.target as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;
		fileUploading = true;
		fileError = '';
		try {
			const data = new FormData();
			data.set('file', file);
			data.set('contactId', detailId);
			const res = await fetch('/api/v1/files', { method: 'POST', body: data });
			const result = await res.json();
			if (!res.ok) throw new Error(result.error || 'Upload failed');
			await loadFiles();
			feedback = 'Private attachment saved.';
		} catch (e) {
			fileError = e instanceof Error ? e.message : 'Upload failed';
		} finally {
			fileUploading = false;
			input.value = '';
		}
	}
	async function loadAudit() {
		try {
			const res = await fetch('/api/v1/audit?tenant=' + tenant);
			const result = await res.json();
			if (!res.ok) throw new Error(result.error || 'Audit unavailable');
			auditItems = result.items || [];
		} catch (e) {
			error = e instanceof Error ? e.message : 'Audit unavailable';
		}
	}
	function open(resource: string, item?: Entity) {
		error = '';
		feedback = '';
		editId = item?.id || '';
		form = item ? { ...item } : resource === 'households' ? { memberIds: [] } : {};
		modal = resource;
	}
	async function mutate(resource: string, data: Record<string, any>, action = 'create') {
		saving = true;
		error = '';
		feedback = '';
		try {
			data = Object.fromEntries(
				Object.entries(data).filter(
					([key, value]) =>
						![
							'createdAt',
							'updatedAt',
							'tenantId',
							'tenant_id',
							'actorId',
							'userId',
							'tagText'
						].includes(key) &&
						value !== undefined &&
						!(key.endsWith('Id') && value === '')
				)
			);
			const res = await fetch('/api/v1/workspace?compact=true', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ tenant, resource, data, action })
			});
			const body = await res.json();
			if (!res.ok) throw new Error(body.error || 'Changes could not be saved.');
			if (body.workspace) {
				workspace = body.workspace;
				workspaceRevision += 1;
			} else await load();
			feedback = 'Saved. A little progress, a lasting difference.';
			return body;
		} catch (e) {
			error = e instanceof Error ? e.message : 'Unable to save';
			return null;
		} finally {
			saving = false;
		}
	}
	async function save() {
		let data = { ...form };
		if (editId) data.id = editId;
		if (modal === 'contacts')
			data.tags =
				typeof data.tagText === 'string'
					? data.tagText
							.split(',')
							.map((x: string) => x.trim())
							.filter(Boolean)
					: data.tags || [];
		if (modal === 'gifts') {
			data.amountMinor = majorToMinor(
				data.amount,
				data.currency || workspace?.tenant.currency || 'USD'
			);
			delete data.amount;
			data.currency = 'USD';
			data.kind = data.kind || 'one_time';
			data.status = data.kind === 'pledge' ? 'pledged' : 'recorded';
			if (!data.contactId) delete data.contactId;
			if (!data.campaignId) delete data.campaignId;
		}
		if (modal === 'campaigns') {
			data.goalMinor = Math.round(Number(data.goal || 0) * 100);
			delete data.goal;
			data.status = data.status || 'draft';
		}
		if (modal === 'households') {
			data.memberIds = data.memberIds || [];
		}
		if (modal === 'segments') {
			data.rules = [
				{
					field: data.ruleField || 'stage',
					operator: data.ruleOperator || 'equals',
					value: data.ruleValue || ''
				}
			];
			delete data.ruleField;
			delete data.ruleOperator;
			delete data.ruleValue;
		}
		if (modal === 'events' && data.capacity) data.capacity = Number(data.capacity);
		if (modal === 'activities') {
			data.kind = data.kind || 'note';
			data.contactId = detailId;
		}
		const result = await mutate(modal, data, editId ? 'update' : 'create');
		if (result) modal = '';
	}
	async function toggleTask(task: Entity) {
		await mutate(
			'tasks',
			{ ...task, status: task.status === 'completed' ? 'open' : 'completed' },
			'update'
		);
	}
	async function simulate(automation: Entity) {
		const result = await mutate('automations', automation, 'simulate');
		if (result) simulation = result.item?.result || 'Simulation complete. No messages transmitted.';
	}
	async function exportContacts() {
		const response = await fetch('/api/v1/contacts/export?tenant=' + tenant);
		if (!response.ok) {
			error = 'Export could not be completed. Check your permission.';
			return;
		}
		const blob = await response.blob();
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = 'contacts.csv';
		a.click();
		URL.revokeObjectURL(url);
	}
	async function importContacts(dryRun = true) {
		saving = true;
		error = '';
		try {
			const res = await fetch('/api/v1/contacts/import', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ tenant, csv: importText, dryRun })
			});
			const result = await res.json();
			if (!res.ok) throw new Error(result.error || 'Import failed');
			importResult = result;
			if (!dryRun) await load();
		} catch (e) {
			error = e instanceof Error ? e.message : 'Import failed';
		} finally {
			saving = false;
		}
	}

	function segmentMembers(segment: Entity) {
		return (workspace?.contacts || []).filter((contact) =>
			(segment.rules || []).every((rule: any) => {
				const actual = contact[rule.field],
					value = String(rule.value || '').toLowerCase();
				if (rule.operator === 'is_empty')
					return !actual || (Array.isArray(actual) && !actual.length);
				if (rule.operator === 'contains')
					return String(actual || '')
						.toLowerCase()
						.includes(value);
				if (rule.operator === 'greater_than') return Number(actual) > Number(rule.value);
				if (rule.operator === 'less_than') return Number(actual) < Number(rule.value);
				return String(actual || '').toLowerCase() === value;
			})
		);
	}
	async function findPaths() {
		error = '';
		saving = true;
		try {
			const res = await fetch('/api/v1/relationships/paths', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ tenant, fromId: pathFrom, toId: pathTo, depth: Number(pathDepth) })
			});
			const result = await res.json();
			if (!res.ok) throw new Error(result.error);
			pathResults = result;
		} catch (e) {
			error = e instanceof Error ? e.message : 'Could not find paths';
		} finally {
			saving = false;
		}
	}
	async function researchImport(apply = false) {
		error = '';
		saving = true;
		try {
			const res = await fetch('/api/v1/research/jobs', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ tenant, xml: researchXml, sourceUrl: researchSource, apply })
			});
			const result = await res.json();
			if (!res.ok) throw new Error(result.error);
			researchResult = result;
			if (apply) await load();
		} catch (e) {
			error = e instanceof Error ? e.message : 'Could not import filing';
		} finally {
			saving = false;
		}
	}
	async function askAI() {
		saving = true;
		aiResponse = '';
		error = '';
		try {
			const res = await fetch('/api/v1/ai/summary', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ question: aiPrompt })
			});
			const result = await res.json();
			if (!res.ok)
				throw new Error(result.error || 'Provider is unavailable. No answer was generated.');
			aiResponse = result.answer || result.text || 'No answer returned.';
		} catch (e) {
			error = e instanceof Error ? e.message : 'AI is unavailable';
		} finally {
			saving = false;
		}
	}
	async function saveProvider() {
		saving = true;
		error = '';
		try {
			const { provider, ...data } = providerForm;
			const res = await fetch('/api/v1/integrations/' + provider, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(data)
			});
			const result = await res.json();
			if (!res.ok) throw new Error(result.error || 'Connection could not be saved.');
			providerForm = { provider, enabled: false };
			modal = '';
			feedback = 'Encrypted integration configuration saved.';
			await load();
		} catch (e) {
			error = e instanceof Error ? e.message : 'Could not save integration';
		} finally {
			saving = false;
		}
	}
	function keydown(event: KeyboardEvent) {
		if ((event.metaKey || event.ctrlKey) && event.key === 'k') {
			event.preventDefault();
			command = !command;
		}
		if (event.key === 'Escape') {
			command = false;
			modal = '';
			mobileNav = false;
			notifications = false;
		}
	}
</script>

<svelte:head
	><title
		>{section === 'overview'
			? 'Your giving, growing'
			: section.charAt(0).toUpperCase() + section.slice(1)} · Donor CRM</title
	></svelte:head
>
<svelte:window onkeydown={keydown} />
<a class="skip-link" href="#main-content">Skip to main content</a>
<div class="app-shell">
	<aside id="workspace-navigation" class:mobile-open={mobileNav} class="sidebar">
		<a href={base + '/overview'} class="brand"
			><img src="/brand/generous-dots.svg" width="34" height="34" alt="" />Donor CRM<span
				class="brand-period">.</span
			></a
		>
		<label class="tenant-select"
			><span class="org-symbol">r<span>↗</span></span><span
				><small>YOUR WORKSPACE</small><select
					aria-label="Switch tenant"
					disabled={tenantSwitching}
					value={tenant}
					onchange={changeTenant}
					>{#each workspace?.memberships || [{ slug: tenant, name: tenant }] as membership}<option
							value={membership.slug}>{membership.name}</option
						>{/each}</select
				></span
			></label
		>
		<button class="search-launch" onclick={() => (command = true)}
			><Search size={16} /> Find anything <kbd>⌘ K</kbd></button
		>
		<nav aria-label="Main navigation">
			{#each navigation as item}<a
					class:active={section === item.path ||
						(item.path === 'gifts' &&
							['campaigns', 'recurring', 'pledges', 'events'].includes(section)) ||
						(item.path === 'relationships' && section === 'introductions')}
					href={base + '/' + item.path}
					onclick={() => {
						mobileNav = false;
						search = '';
						filter = 'all';
						currentPage = 1;
					}}
					><item.icon size={19} strokeWidth={1.7} />{item.label}{#if item.path === 'prospects'}<span
							class="nav-count">{workspace?.prospects.length || 0}</span
						>{/if}</a
				>{/each}
		</nav>
		<div class="sidebar-bottom">
			<div class="purpose-note">
				<Leaf size={22} />
				<p>Good things take people.<br /><strong>You’re in the right place.</strong></p>
			</div>
			<a class:active={section === 'settings'} href={base + '/settings/general'}
				><Settings size={18} /> Settings</a
			><a href={base + '/settings/help'}><CircleHelp size={18} /> A little help</a>
			<div class="user-row">
				<span class="avatar user-avatar">{initials(workspace?.user?.name || 'Staff')}</span><span
					><strong>{workspace?.user?.name || 'Staff'}</strong><small
						>{workspace?.tenant.demo ? 'Demo workspace' : 'Workspace'} · {workspace?.user?.role ||
							'Owner'}</small
					></span
				><button
					class="icon-button"
					aria-label="Sign out"
					onclick={async () => {
						await fetch('/api/v1/session', { method: 'DELETE' });
						goto('/');
					}}><LogOut size={16} /></button
				>
			</div>
		</div>
	</aside>
	<div class="main-shell">
		<header class="topbar">
			<button
				class="icon-button mobile-menu"
				aria-label={mobileNav ? 'Close navigation' : 'Open navigation'}
				aria-expanded={mobileNav}
				aria-controls="workspace-navigation"
				onclick={() => (mobileNav = !mobileNav)}><Menu size={22} /></button
			>
			<div class="breadcrumb">
				Workspace <span>/</span>
				<strong
					>{section === 'contacts'
						? 'People'
						: section.charAt(0).toUpperCase() + section.slice(1)}</strong
				>
			</div>
			<div class="topbar-right">
				<span class="demo-label"
					><span></span>{workspace?.tenant.demo ? 'Synthetic demo' : 'Private workspace'}</span
				>{#key tenant}<NotificationInbox {tenant} />{/key}<a
					href="/account/preferences"
					aria-label={initials(workspace?.user?.name || 'Staff') + ' account preferences'}
					class="avatar top-avatar">{initials(workspace?.user?.name || 'Staff')}</a
				>
			</div>
		</header>
		<main id="main-content">
			{#if workspace?.tenant.demo}<p class="banner" role="note">
					Shared synthetic demo — use sample data only. Changes are temporary and visible to other
					demo visitors.
				</p>{/if}
			{#if error}<div class="banner error" role="alert">
					{error}<button class="icon-button" onclick={() => (error = '')} aria-label="Dismiss error"
						><X size={16} /></button
					>
				</div>{/if}
			{#if feedback}<div class="banner success" role="status">
					<CheckCircle2 size={17} />{feedback}<button
						class="icon-button"
						onclick={() => (feedback = '')}
						aria-label="Dismiss saved message"><X size={16} /></button
					>
				</div>{/if}
			{#if loading}<div class="loading-state" aria-busy="true" aria-label="Loading workspace">
					<div class="skeleton title"></div>
					<div class="skeleton subtitle"></div>
					<div class="skeleton chart-skeleton"></div>
					<p>Gathering the good…</p>
				</div>
			{:else if !workspace}<div class="empty-state">
					<h1>A little pause.</h1>
					<p>Your workspace could not be loaded.</p>
					<button onclick={load} class="primary">Try again</button>
				</div>
			{:else if section === 'overview'}
				<div class="page-heading">
					<div>
						<div class="eyebrow">
							{new Date()
								.toLocaleDateString('en-US', {
									weekday: 'long',
									month: 'long',
									day: 'numeric',
									timeZone: workspace.tenant.timeZone
								})
								.toUpperCase()} <span class="small-spark">✳</span> A GOOD DAY TO DO GOOD
						</div>
						<h1>
							{#if greeting}{greeting}{:else}Small moments.<br /><em>Extraordinary impact.</em>{/if}
						</h1>
						<p class="lede">
							Welcome back, {workspace.user?.name?.split(' ')[0] || 'there'}. Here’s the good you’re
							growing.
						</p>
					</div>
					<button class="primary" onclick={() => open('gifts')}
						><Plus size={17} /> Record a gift</button
					>
				</div>
				{#if !workspace.tenant.demo && (workspace.overview?.contactCount ?? workspace.contacts.length) === 0}<OnboardingChecklist
					/>{/if}
				{#if !workspace.contacts.length && !workspace.gifts.length}<div class="welcome-empty">
						<Leaf size={32} />
						<div>
							<h2>A good beginning.</h2>
							<p>
								Your private workspace is ready. Add your first supporter or import a reviewed CSV
								to begin.
							</p>
						</div>
						<button class="secondary" onclick={() => open('contacts')}
							>Add your first person <Plus size={16} /></button
						>
					</div>{/if}
				<div class="overview-stats">
					<div class="stat-main">
						<span class="section-label">TOTAL GIVING <span class="info-dot">i</span></span>
						<div class="big-number">{money(totalGiving)}</div>
						<span class="stat-context"
							><span class="positive">↗ Recorded gifts</span> {chartPeriod}</span
						>
					</div>
					<div class="stat">
						<span class="section-label">PEOPLE BEHIND THE GOOD</span>
						<div class="stat-number">
							{workspace.overview?.contactCount ??
								workspace.contacts.filter((c) => !c.archived).length}<span class="stat-doodle"
								>✳</span
							>
						</div>
						<a href={base + '/contacts'}>Meet your community <ArrowUpRight size={15} /></a>
					</div>
					<div class="stat">
						<span class="section-label">RECURRING CONTRIBUTIONS</span>
						<div class="stat-number">{money(recurring)}</div>
						<span class="stat-context">Recorded recurring gifts this period</span>
					</div>
				</div>
				<div class="overview-grid">
					<section class="giving-chart">
						<div class="section-heading">
							<div>
								<h2>Generosity, in motion</h2>
								<p>Every gift is a little more possibility.</p>
							</div>
							<a class="text-button" href={base + '/gifts'}
								>{chartPeriod} <ChevronDown size={14} /></a
							>
						</div>
						<div class="chart-legend">
							<span class="legend-dot"></span> Recorded giving
							<span class="muted">{workspace.tenant.currency} · gross, before fees</span>
						</div>
						<Chart
							values={chartValues}
							labels={chartMonths.map((m) => m.label)}
							currency={workspace.tenant.currency}
							onclick={(i) => {
								goto(base + '/gifts?month=' + chartMonths[i].key);
							}}
						/>
						<div class="chart-footer">
							<span
								><span class="tiny-spark">✳</span> A future built one generous moment at a time.</span
							><a href={base + '/reports'} aria-label="View giving reports"
								><ArrowUpRight size={19} /></a
							>
						</div>
					</section>
					<section class="next-steps">
						<div class="section-heading">
							<div>
								<span class="eyebrow">MAKE A LITTLE ROOM FOR</span>
								<h2>Your next good move</h2>
							</div>
							<span class="count-circle">{openTasks.length}</span>
						</div>
						{#each openTasks.slice(0, 3) as task}<div class="task-row">
								<button
									class="task-check"
									aria-label={'Complete ' + task.title}
									onclick={() => toggleTask(task)}><Circle size={21} /></button
								>
								<div>
									<a href={task.contactId ? base + '/contacts/' + task.contactId : base + '/tasks'}
										>{task.title}</a
									><span
										>{date(task.dueAt)} <i>·</i>
										{task.priority === 'high' ? 'A little time-sensitive' : 'Stewardship'}</span
									>
								</div>
								<ArrowUpRight size={15} />
							</div>{:else}<div class="empty-inline">All caught up. Take a breath. ✳</div>{/each}<a
							class="all-link"
							href={base + '/tasks'}>See all tasks <ArrowRight size={16} /></a
						>
						<div class="intro-nudge">
							<span class="nudge-symbol">↗</span>
							<div>
								<strong>Good grows through connection.</strong>
								<p>
									{workspace.introductions.filter((x) => !['closed', 'donated'].includes(x.stage))
										.length} introduction waiting for a thoughtful next step.
								</p>
								<a href={base + '/introductions'}>Make a connection <ArrowRight size={14} /></a>
							</div>
						</div>
					</section>
				</div>
				<section class="campaign-section">
					<div class="section-heading">
						<div>
							<span class="eyebrow">PURPOSE, WITH MOMENTUM</span>
							<h2>Big ideas taking root</h2>
						</div>
						<a class="text-button" href={base + '/campaigns'}
							>All campaigns <ArrowUpRight size={16} /></a
						>
					</div>
					<div class="campaign-grid">
						{#each workspace.campaigns as campaign, i}<a
								class={'campaign-feature campaign-color-' + i}
								href={base + '/campaigns/' + campaign.id}
								><div class="campaign-art" aria-hidden="true">
									{#if i === 0}<div class="sprout">
											<span></span><span></span><span></span>
										</div>{:else if i === 1}<div class="table-art">
											<span>✳</span><span>◡</span><span>✳</span>
										</div>{:else}<div class="sun-art">✺</div>{/if}<span class="campaign-tag"
										>{campaign.status}</span
									><ArrowUpRight size={20} />
								</div>
								<div class="campaign-copy">
									<h3>{campaign.name}</h3>
									<p>
										<strong>{money(campaignGiving(campaign.id))}</strong>
										<span>of {money(campaign.goalMinor)} goal</span>
									</p>
									<div class="progress-track">
										<span
											style:width={Math.min(
												100,
												(campaignGiving(campaign.id) / (campaign.goalMinor || 1)) * 100
											) + '%'}
										></span>
									</div>
									<div class="campaign-meta">
										<span>{date(campaign.endsAt)} target</span><span>Keep it growing ↗</span>
									</div>
								</div></a
							>{/each}
					</div>
				</section>
				<section class="recent-section">
					<div class="section-heading">
						<h2>A ripple of generosity</h2>
						<a class="text-button" href={base + '/gifts'}>All gifts <ArrowUpRight size={16} /></a>
					</div>
					<div class="table-scroll">
						<table>
							<thead
								><tr
									><th>THE PERSON</th><th>THE GIFT</th><th>THE PURPOSE</th><th>WHEN</th><th
									></th></tr
								></thead
							><tbody
								>{#each [...(workspace.overview?.recentGifts || workspace.gifts)]
									.sort( (a, b) => String(b.occurredAt || b.createdAt).localeCompare(String(a.occurredAt || a.createdAt)) )
									.slice(0, 4) as gift}<tr
										><td
											><a class="person-cell" href={base + '/contacts/' + gift.contactId}
												><span
													class="avatar"
													style:--avatar-hue={(workspace.contacts.findIndex(
														(c) => c.id === gift.contactId
													) *
														43) %
														360}>{initials(gift.contactName || contactName(gift.contactId))}</span
												><strong>{gift.contactName || contactName(gift.contactId)}</strong></a
											></td
										><td
											><strong>{money(gift.amountMinor)}</strong
											>{#if gift.kind === 'recurring'}<span class="mini-badge">↻ Recurring</span
												>{/if}</td
										><td>{campaignName(gift.campaignId)}</td><td class="muted"
											>{date(gift.occurredAt || gift.createdAt)}</td
										><td><ArrowUpRight size={16} /></td></tr
									>{/each}</tbody
							>
						</table>
					</div>
				</section>
			{:else if section === 'contacts' && currentContact}
				<a class="back-link" href={base + '/contacts'}><ArrowLeft size={15} /> Your people</a>
				<div class="profile-heading">
					<span class="avatar profile-avatar">{initials(currentContact.name)}</span>
					<div>
						<span class="eyebrow">{currentContact.stage || 'SUPPORTER'}</span>
						<h1>{currentContact.name}</h1>
						<p>
							{currentContact.email || 'No email on file'} <span class="dot-sep">·</span>
							{currentContact.source || 'Added by your team'}
						</p>
					</div>
					<button class="secondary" onclick={() => open('contacts', currentContact)}
						><SlidersHorizontal size={16} /> Edit profile</button
					><button
						class="secondary"
						onclick={() => {
							modal = 'merge';
							mergeTarget = '';
							mergePreview = null;
						}}>Merge duplicate</button
					><button
						class="icon-button"
						aria-label="Archive person"
						onclick={() => {
							modal = 'archive';
							form = { ...currentContact };
						}}><MoreHorizontal size={19} /></button
					>
				</div>
				{#if lastMerge}<div class="banner neutral">
						A merge was just completed.<button
							class="text-button"
							onclick={undoMerge}
							disabled={saving}>Undo merge <ArrowLeft size={14} /></button
						>
					</div>{/if}
				<div class="profile-summary">
					<div>
						<span class="section-label">HARD-CREDIT GIVING</span><strong
							>{money(givingFor(currentContact.id))}</strong
						>
					</div>
					<div>
						<span class="section-label">GIFTS TO DATE</span><strong
							>{contactSummaries[currentContact.id]?.reduce(
								(n: number, c: any) => n + c.giftCount,
								0
							) ??
								workspace.gifts.filter((g) => canonical(g.contactId) === currentContact.id)
									.length}</strong
						>
					</div>
					<div>
						<span class="section-label">COMMUNICATION CONSENT</span><strong class="text-small"
							>{currentContact.consent ? 'Opted in' : 'Not recorded'}</strong
						>
					</div>
					<div>
						<span class="section-label">RELATIONSHIP STAGE</span><strong class="text-small"
							>{currentContact.stage || 'Supporter'}</strong
						>
					</div>
				</div>
				<div class="tabs" role="tablist" aria-label="Contact sections">
					{#each ['Activity', 'Details', 'Giving', 'Connections', 'Tasks', 'Emails', 'Research', 'Files'] as tab}<button
							role="tab"
							aria-selected={profileTab === tab}
							class:chosen={profileTab === tab}
							onclick={() => {
								profileTab = tab;
								if (tab === 'Files') loadFiles();
								if (tab === 'Giving') loadReceipts();
							}}>{tab}</button
						>{/each}
				</div>
				<div class="section-heading">
					<h2>{profileTab === 'Activity' ? 'Every moment matters' : profileTab}</h2>
					{#if profileTab === 'Activity'}<button
							class="secondary"
							onclick={() => open('activities')}><Plus size={16} /> Add a note</button
						>{/if}
				</div>
				{#if profileTab === 'Details'}{#key currentContact.id}<ContactDetails
							{tenant}
							contactId={currentContact.id}
							onChanged={load}
						/>{/key}
				{:else if profileTab === 'Giving'}{#key currentContact.id}<GivingManager
							{tenant}
							contactId={currentContact.id}
							contacts={workspace.contacts}
							campaigns={workspace.campaigns}
							onChanged={load}
						/>{/key}
					<section class="receipt-list">
						<h3>Receipt snapshots</h3>
						{#if receiptError}<p class="banner error" role="alert">
								{receiptError}
							</p>{/if}{#each receipts as receipt}<a
								class="list-row"
								href={'/api/v1/receipts/' + receipt.id}
								><FileText size={20} />{receipt.receiptNumber} · {money(receipt.amountMinor)}</a
							>{:else}<p>
								No generated receipts yet. Receipts are generated asynchronously from gift events.
							</p>{/each}
					</section>
				{:else if ['Activity', 'Emails'].includes(profileTab)}{#key currentContact.id + profileTab}<ContactTimeline
							contactId={currentContact.id}
							kind={profileTab === 'Emails' ? 'email' : 'all'}
						/>{/key}
				{:else if profileTab === 'Tasks'}{#key currentContact.id}<Stewardship
							{tenant}
							contactId={currentContact.id}
						/>{/key}
				{:else if profileTab === 'Files'}<div class="private-files">
						<p class="small muted">
							Files are private to your tenant. Allowed: PDF, PNG, JPEG, WebP, plain text · 25 MiB
							maximum. Production requires a clean malware scan.
						</p>
						<label class="file-upload-label"
							>{fileUploading ? 'Uploading and scanning…' : 'Attach a private file'}<input
								type="file"
								accept=".pdf,.png,.jpg,.jpeg,.webp,.txt"
								disabled={fileUploading || workspace.tenant.demo}
								onchange={uploadFile}
							/></label
						>{#if workspace.tenant.demo}<p class="banner neutral">
								File storage is available only with a configured persistent database. Demo uploads
								are disabled.
							</p>{/if}{#if fileError}<p class="banner error" role="alert">
								{fileError}
							</p>{/if}{#each files as file}<a class="list-row" href={'/api/files/' + file.id}
								><FileText size={22} />
								<div>
									<h3>{file.name}</h3>
									<p>
										{Math.ceil(file.sizeBytes / 1024)} KiB · {file.scanStatus} · {date(
											file.uploadedAt
										)}
									</p>
								</div>
								<Download size={18} /></a
							>{:else}<p class="empty-inline">
								No private attachments linked to this person.
							</p>{/each}
					</div>
				{:else if profileTab === 'Research'}<ProspectWorkbench
						{tenant}
						workspace={{
							...workspace,
							prospects: workspace.prospects.filter((p) => p.contactId === currentContact.id)
						}}
						onChanged={load}
					/>
				{:else if profileTab === 'Connections'}{#each workspace.relationships.filter((r) => r.fromId === currentContact.id || r.toId === currentContact.id) as edge}<div
							class="evidence-row"
						>
							<Network />
							<div>
								<strong>{edge.kind.replaceAll('_', ' ')}</strong>
								<p>{edge.evidence} · {edge.confidence} confidence</p>
								<p>Public affiliation does not establish a personal acquaintance.</p>
							</div>
						</div>{:else}<p class="empty-inline">No evidence-backed connections yet.</p>{/each}<a
						class="text-button"
						href={base + '/relationships'}>Explore relationships <ArrowUpRight size={16} /></a
					>
				{:else}<div class="empty-state">
						<Leaf size={32} />
						<h3>A little space for what’s next.</h3>
						<p>No {profileTab.toLowerCase()} are linked to this person.</p>
						{#if profileTab === 'Files'}<p class="muted small">
								Private file upload is not enabled in this build.
							</p>{/if}
					</div>{/if}
			{:else if section === 'contacts'}
				{#key tenant}<ContactDirectory
						{tenant}
						onAdd={() => open('contacts')}
						refreshKey={workspaceRevision}
						onChanged={load}
					/>{/key}
			{:else if ['gifts', 'recurring', 'pledges'].includes(section)}
				<GivingManager
					{tenant}
					contacts={workspace.contacts}
					campaigns={workspace.campaigns}
					view={section}
					onChanged={load}
				/>
			{:else if section === 'campaigns'}<CampaignBuilder {tenant} />
			{:else if section === 'tasks'}
				<Stewardship {tenant} />
			{:else if section === 'prospects' && currentProspect}
				<a class="back-link" href={base + '/prospects'}><ArrowLeft size={15} /> Discover</a>
				<div class="page-heading compact">
					<div>
						<span class="eyebrow">RESEARCH, WITH CONTEXT</span>
						<h1>{currentProspect.name}</h1>
						<p class="lede">{currentProspect.reason}</p>
					</div>
					<button
						class="primary"
						onclick={() => {
							open('introductions');
							form.prospectId = currentProspect.id;
						}}>Request an introduction</button
					>
				</div>
				<div class="editor-grid">
					<section>
						<h2>Evidence comes first</h2>
						{#each currentProspect.evidence || [] as evidence}<article class="evidence-row">
								<FileText size={24} />
								<div>
									<h3>{evidence.sourceName}</h3>
									<p>
										Observed {date(evidence.observedAt)} · Confidence: {evidence.confidence ||
											'Unreviewed'}
									</p>
									{#if evidence.sourceUrl}<a
											href={evidence.sourceUrl}
											rel="noreferrer"
											target="_blank">View source <ExternalLink size={14} /></a
										>{/if}
								</div>
							</article>{/each}
						<p class="banner neutral">
							Synthetic demonstration evidence. A public affiliation does not prove personal
							familiarity or a donation.
						</p>
					</section>
					<aside class="editor-note">
						<span class="section-label">REVIEW PRIORITY</span>
						<div class="big-number">{currentProspect.score}<small>/100</small></div>
						<p>Demonstration score. Live explainable ranking is not enabled.</p>
						<label
							>Pipeline stage<select
								value={currentProspect.stage}
								onchange={(e) =>
									mutate(
										'prospects',
										{ ...currentProspect, stage: e.currentTarget.value },
										'update'
									)}
								>{#each ['discovered', 'screened', 'qualified', 'assigned', 'introduction_requested', 'contacted', 'meeting', 'solicited', 'committed', 'donated', 'stewarded', 'rejected'] as stage}<option
										value={stage}>{stage.replaceAll('_', ' ')}</option
									>{/each}</select
							></label
						>
					</aside>
				</div>
			{:else if section === 'prospects'}<ProspectWorkbench {tenant} {workspace} onChanged={load} />
			{:else if ['relationships', 'introductions'].includes(section)}<IntelligenceExplorer
					{tenant}
					{workspace}
					onChanged={load}
				/>
			{:else if section === 'email'}
				{#key detailId}<EmailStudio
						{tenant}
						emailId={detailId}
						demo={Boolean(workspace.tenant.demo)}
						onChanged={load}
					/>{/key}
			{:else if section === 'automations'}
				<AutomationEditor {tenant} /><JobMonitor {tenant} />
			{:else if section === 'reports'}<ReportsExplorer
					{tenant}
					contacts={workspace.contacts}
					campaigns={workspace.campaigns}
				/>
			{:else if section === 'events'}<EventManager {tenant} />
			{:else if ['organizations', 'households', 'segments'].includes(section)}
				<div class="tabs">
					<a href={base + '/contacts'}>All people</a
					>{#each ['households', 'organizations', 'segments', 'events'] as tab}<a
							class:chosen={section === tab}
							href={base + '/' + tab}>{tab.charAt(0).toUpperCase() + tab.slice(1)}</a
						>{/each}
				</div>
				{#key tenant + section + JSON.stringify(workspace[section as 'organizations' | 'households' | 'segments'])}<CollectionDirectory
						{tenant}
						resource={section as 'organizations' | 'households' | 'segments'}
						contacts={workspace.contacts}
						onCreate={() => open(section)}
						onEdit={(item) => {
							open(section, item as Entity);
							if (section === 'segments') {
								form.ruleField = item.rules?.[0]?.field;
								form.ruleOperator = item.rules?.[0]?.operator;
								form.ruleValue = item.rules?.[0]?.value;
							}
						}}
					/>{/key}
			{:else if section === 'ai'}
				<Assistant {tenant} />
			{:else if section === 'settings'}
				<div class="page-heading compact">
					<div>
						<span class="eyebrow">MAKE THIS SPACE YOURS</span>
						<h1>A thoughtful foundation<span class="heading-dot">.</span></h1>
						<p class="lede">Your workspace, preferences, and connections.</p>
					</div>
				</div>
				<div class="tabs scroll-tabs">
					{#each ['general', 'branding', 'users', 'roles', 'stripe', 'email', 'ai', 'integrations', 'security', 'fields', 'jobs', 'api', 'audit'] as tab}<a
							class:chosen={(detailId || 'general') === tab}
							href={base + '/settings/' + tab}
							onclick={() => {
								if (tab === 'audit') loadAudit();
							}}>{tab.charAt(0).toUpperCase() + tab.slice(1)}</a
						>{/each}
				</div>
				{#if detailId === 'branding'}<BrandingSettings demo={Boolean(workspace.tenant.demo)} />
				{:else if ['users', 'roles', 'security', 'team'].includes(detailId)}<IdentitySettings />
				{:else if detailId === 'api'}<AdminConsole {tenant} />
				{:else if detailId === 'fields'}<ContactDetails {tenant} />
				{:else if detailId === 'jobs'}<JobMonitor {tenant} />
				{:else if ['general', 'branding'].includes(detailId || 'general')}<div
						class="settings-grid"
					>
						<section>
							<h2>
								{detailId === 'branding' ? 'A space that feels like you' : 'Your organization'}
							</h2>
							<form
								class="stacked-form"
								onsubmit={async (e) => {
									e.preventDefault();
									await mutate('settings', workspace!.settings);
								}}
							>
								<label
									>Organization name<input
										required
										bind:value={workspace.settings.organizationName}
									/></label
								>
								<div class="field-pair">
									<label
										>Currency<select bind:value={workspace.settings.currency}
											><option>USD</option></select
										></label
									><label
										>Time zone<input required bind:value={workspace.settings.timeZone} /></label
									>
								</div>
								<button class="primary" disabled={saving}
									>{saving ? 'Saving…' : 'Save organization'}</button
								>
							</form>
						</section>
						<aside>
							<h2>A change of scenery</h2>
							<p>Your appearance preference stays in this browser.</p>
							<label
								>Personal welcome heading<input
									maxlength="120"
									bind:value={greeting}
									placeholder="Small moments. Extraordinary impact."
								/></label
							><button
								class="secondary"
								onclick={async () => {
									const r = await fetch('/api/v1/preferences', {
										method: 'PATCH',
										headers: { 'content-type': 'application/json' },
										body: JSON.stringify({ greeting })
									});
									if (r.ok) feedback = 'Welcome heading saved for your account.';
									else error = 'Welcome heading could not be saved.';
								}}>Save welcome heading</button
							>
							<label
								>Color mode<select bind:value={mode} onchange={applyTheme}
									><option value="system">System</option><option value="light">Light</option><option
										value="dark">Dark</option
									></select
								></label
							><button
								class="secondary theme-brand"
								aria-pressed={theme === 'donor-crm'}
								onclick={() => {
									theme = 'donor-crm';
									applyTheme();
								}}
								>Donor CRM · brand palette {#if theme === 'donor-crm'}<Check
										size={15}
									/>{/if}</button
							>
							<div class="theme-grid">
								{#each themes as name}<button
										data-theme={name}
										class:theme-selected={theme === name}
										class="theme-swatch"
										onclick={() => {
											theme = name;
											applyTheme();
										}}
										aria-pressed={theme === name}
										><span class="swatch-colors"><i></i><i></i><i></i></span><span>{name}</span
										>{#if theme === name}<Check size={14} />{/if}</button
									>{/each}
							</div>
							<p class="small muted">
								Themes discovered from Skeleton 5.0.1. Neutral brand concept awaits review.
							</p>
						</aside>
					</div>
				{:else if ['stripe', 'email', 'ai', 'integrations'].includes(detailId)}{#if detailId === 'email'}<SenderDiagnostics
							demo={Boolean(workspace.tenant.demo)}
						/>{/if}
					<div class="integration-list">
						{#if detailId === 'stripe'}<section class="stripe-connection">
								<h2>Your Stripe account</h2>
								<p class="muted small">
									Each organization connects its own account through Stripe OAuth. Card details
									remain in secure Stripe-hosted elements.
								</p>
								<div class="button-group">
									<button class="secondary" onclick={getStripeStatus}>Check account status</button>
									<form method="POST" action="/api/v1/payments/connect">
										<button class="primary" disabled={workspace.tenant.demo}
											>Connect with Stripe <ExternalLink size={15} /></button
										>
									</form>
								</div>
								{#if stripeStatus}<p class="banner neutral">
										{stripeStatus.connected
											? 'Connected · ' +
												(stripeStatus.accountId || '') +
												' · ' +
												(stripeStatus.livemode ? 'Live mode' : 'Test mode')
											: 'No Stripe account connected.'}
									</p>
									{#if stripeStatus.connected}<button
											class="secondary"
											onclick={async () => {
												const res = await fetch('/api/v1/payments/connect', { method: 'DELETE' });
												if (res.ok) {
													stripeStatus = { connected: false };
													feedback =
														'Stripe disconnected. Historical financial events are retained.';
												} else error = 'Stripe could not be disconnected.';
											}}>Disconnect Stripe</button
										>{/if}{/if}
							</section>{/if}{#each integrationConfigs as config}<article class="integration-row">
								<span class="integration-symbol">{config.provider === 'openai' ? '✳' : '✉'}</span>
								<div>
									<h2>{config.provider === 'openai' ? 'OpenAI API' : 'AWS SES'}</h2>
									<p>
										{config.status} · {config.configured
											? 'Encrypted credentials stored'
											: 'Not configured'}
									</p>
								</div>
								<button
									class="secondary"
									onclick={() => {
										modal = 'provider';
										providerForm = {
											provider: config.provider,
											enabled: false,
											model: 'gpt-4.1-mini'
										};
									}}>Configure</button
								>{#if config.configured}<button
										class="secondary"
										onclick={async () => {
											const res = await fetch('/api/v1/integrations/' + config.provider, {
												method: 'DELETE'
											});
											if (res.ok) {
												feedback = 'Integration disconnected. Historical records retained.';
												await load();
											} else error = 'Disconnect failed.';
										}}>Disconnect</button
									>{/if}
							</article>{/each}<button
							class="secondary"
							onclick={() => {
								modal = 'provider';
								providerForm = { provider: 'openai', enabled: false, model: 'gpt-4.1-mini' };
							}}><Plus size={16} /> Configure provider</button
						>{#each [{ name: 'Stripe', description: 'Embedded giving and recurring payments', status: 'Disconnected', path: 'stripe' }, { name: 'AWS SES', description: 'Consent-aware email delivery', status: 'Disconnected', path: 'email' }, { name: 'AI provider', description: 'Tenant API key required', status: 'Unavailable', path: 'ai' }, { name: 'Codex device-code', description: 'Experimental · authorization not validated', status: 'Disabled', path: 'ai' }].filter((x) => detailId === 'integrations' || x.path === detailId) as integration}<article
								class="integration-row"
							>
								<span class="integration-symbol"
									>{integration.name === 'Stripe'
										? 's'
										: integration.name === 'AWS SES'
											? '✉'
											: '✳'}</span
								>
								<div>
									<h2>{integration.name}</h2>
									<p>{integration.description}</p>
								</div>
								<span class="pill">{integration.status}</span>
							</article>{/each}
						<div class="editor-note">
							<h3>Connections require a server-side setup.</h3>
							<p>
								No secrets are accepted in this workspace form. Follow the integration guide in the
								repository. AI and SES configurations use encrypted server-side storage. Stripe
								Connect setup is managed separately. SES delivery workflows remain unavailable.
							</p>
							<p>Historical records remain available when an integration is disconnected.</p>
						</div>
					</div>
				{:else if detailId === 'audit'}<div class="section-heading">
						<h2>A clear trail of care</h2>
						<button class="secondary" onclick={loadAudit}>Refresh audit history</button>
					</div>
					<p class="muted small">
						Sensitive reads, exports and changes are recorded with tenant scope.
					</p>
					<div class="table-scroll">
						<table>
							<thead><tr><th>WHEN</th><th>ACTION</th><th>RESOURCE</th><th>ACTOR</th></tr></thead
							><tbody
								>{#each auditItems as event}<tr
										><td>{date(event.createdAt || event.created_at || event.at)}</td><td
											>{event.action}</td
										><td>{event.resource}</td><td
											>{event.actor || event.actorId || event.actor_id || 'System'}</td
										></tr
									>{:else}<tr
										><td colspan="4" class="empty-inline"
											>Refresh to load authorized audit records.</td
										></tr
									>{/each}</tbody
							>
						</table>
					</div>
				{:else}<div class="empty-state">
						<Settings size={32} />
						<h3>Choose a settings page.</h3>
						<p>Use the tabs above to manage your workspace.</p>
					</div>{/if}
			{:else}
				<div class="page-heading compact">
					<div>
						<span class="eyebrow">A LITTLE SPACE FOR WHAT’S NEXT</span>
						<h1>
							{section.charAt(0).toUpperCase() + section.slice(1)}<span class="heading-dot">.</span>
						</h1>
					</div>
				</div>
				<div class="empty-state">
					<Leaf size={36} />
					<h2>Page not found.</h2>
					<p>This page could not be found. Choose a destination from the navigation.</p>
					<a class="secondary" href={base + '/overview'}
						>Back to your overview <ArrowRight size={16} /></a
					>
				</div>
			{/if}
			<footer class="app-footer">
				<span
					><img src="/brand/generous-dots.svg" alt="" width="18" height="18" /> A little connection. A
					lasting difference.</span
				><span
					>Donor CRM · {workspace?.tenant.demo
						? 'Synthetic demonstration'
						: 'Private workspace'}</span
				>
			</footer>
		</main>
	</div>
</div>
{#if command}<div
		class="modal-backdrop"
		role="presentation"
		onclick={(e) => {
			if (e.target === e.currentTarget) command = false;
		}}
	>
		<div
			use:focusTrap
			class="command-dialog"
			role="dialog"
			aria-modal="true"
			aria-label="Search workspace"
			tabindex="-1"
			transition:fly={{
				y: 12,
				duration:
					typeof window !== 'undefined' &&
					window.matchMedia('(prefers-reduced-motion: reduce)').matches
						? 0
						: 160
			}}
		>
			<label class="command-input"
				><Search size={21} /><input
					aria-label="Search everything"
					placeholder="Who or what are you looking for?"
					bind:value={commandQuery}
				/><button class="icon-button" onclick={() => (command = false)} aria-label="Close search"
					><X size={20} /></button
				></label
			>
			{#if commandError}<p class="banner error" role="alert">{commandError}</p>{/if}
			<div class="command-results">
				{#each searchResults as result}<a
						href={result.url}
						onclick={() => {
							command = false;
							commandQuery = '';
						}}
						><span><small>{result.kind}</small><strong>{result.name}</strong></span><ArrowUpRight
							size={18}
						/></a
					>{:else}<p class="empty-inline">No matches in this workspace. Try another name.</p>{/each}
			</div>
			<p class="command-footer">
				Only records in your authorized workspace. <kbd>esc</kbd> to close
			</p>
		</div>
	</div>{/if}
{#if modal}<div
		class="modal-backdrop"
		role="presentation"
		onclick={(e) => {
			if (e.target === e.currentTarget && !saving) modal = '';
		}}
	>
		<div
			use:focusTrap
			class="form-dialog"
			role="dialog"
			aria-modal="true"
			aria-labelledby="dialog-title"
			tabindex="-1"
			transition:fly={{
				y: 16,
				duration:
					typeof window !== 'undefined' &&
					window.matchMedia('(prefers-reduced-motion: reduce)').matches
						? 0
						: 180
			}}
		>
			<div class="dialog-heading">
				<div>
					<span class="eyebrow">A LITTLE PROGRESS STARTS HERE</span>
					<h2 id="dialog-title">
						{modal === 'contacts'
							? editId
								? 'Edit a person'
								: 'Add a person'
							: modal === 'gifts'
								? 'Record a gift'
								: modal === 'campaigns'
									? 'Grow a new idea'
									: modal === 'tasks'
										? 'A thoughtful next step'
										: modal === 'activities'
											? 'Remember this moment'
											: modal === 'prospects'
												? 'Add a research candidate'
												: modal === 'introductions'
													? 'Propose a connection'
													: modal === 'emails'
														? 'Start a conversation'
														: modal === 'automations'
															? 'Create a draft workflow'
															: modal === 'import'
																? 'Bring your people along'
																: modal === 'research'
																	? 'A little curiosity, thoughtfully'
																	: ['organizations', 'households', 'segments', 'events'].includes(
																				modal
																		  )
																		? 'Add ' + modal.slice(0, -1)
																		: 'Document a connection'}
					</h2>
				</div>
				<button
					class="icon-button"
					aria-label="Close dialog"
					onclick={() => (modal = '')}
					disabled={saving}><X size={22} /></button
				>
			</div>
			{#if error}<p class="banner error" role="alert">{error}</p>{/if}
			{#if modal === 'import'}<p>
					Paste CSV with <code>name,email</code> headers. Review duplicates before importing. Nothing
					is sent to these addresses.
				</p>
				<textarea
					aria-label="Contacts CSV"
					rows="8"
					bind:value={importText}
					placeholder="name,email"></textarea>
				<div class="button-group">
					<button
						class="secondary"
						onclick={() => importContacts(true)}
						disabled={saving || !importText}>Preview import</button
					>{#if importResult}<button
							class="primary"
							onclick={() => importContacts(false)}
							disabled={saving}>Import reviewed rows</button
						>{/if}
				</div>
				{#if importResult}<pre class="import-report">{JSON.stringify(
							importResult,
							null,
							2
						)}</pre>{/if}
			{:else if modal === 'research'}<form
					class="stacked-form"
					onsubmit={(e) => {
						e.preventDefault();
						researchImport(false);
					}}
				>
					<label
						>Mission keywords<input
							placeholder="Youth development, food access…"
							bind:value={form.mission}
						/></label
					><label
						>Geography<input placeholder="Phoenix, Arizona" bind:value={form.geography} /></label
					>
					<p class="small muted">
						Mission and geography are planning notes. Import an IRS 990-PF XML return to extract
						reported foundation, trustee and grant-recipient evidence. No personal donation is
						inferred.
					</p>
					<label
						>Original IRS source URL<input
							required
							type="url"
							bind:value={researchSource}
							placeholder="https://apps.irs.gov/pub/epostcard/990/xml/…"
						/></label
					><label
						>IRS 990-PF XML<textarea
							required
							rows="6"
							bind:value={researchXml}
							placeholder="Paste a downloaded XML return"></textarea></label
					><button class="primary" disabled={saving}
						>Preview evidence <ArrowRight size={16} /></button
					>{#if researchResult}<div class="banner neutral">
							{researchResult.ready} new candidates · {researchResult.duplicates} existing records
						</div>
						<div class="research-preview">
							{#each researchResult.records as record}<article>
									<strong>{record.name}</strong>
									<p>{record.reason}</p>
									<small>{record.evidence[0].sourceName}</small>
								</article>{/each}
						</div>
						{#if !workspace?.tenant.demo}<button
								type="button"
								class="secondary"
								disabled={saving}
								onclick={() => researchImport(true)}>Import reviewed candidates</button
							>{:else}<p class="muted small">
								Demo allows previews only. No real prospect data is saved.
							</p>{/if}{/if}
				</form>
			{:else if modal === 'merge'}<p>
					Keep one canonical identity while preserving immutable gifts and a reversible merge
					history. The target wins conflicting values.
				</p>
				<ContactPicker
					{tenant}
					bind:contactId={mergeTarget}
					label="Merge this person into"
					required
					onSelect={() => (mergePreview = null)}
				/>
				<button class="secondary" disabled={!mergeTarget || saving} onclick={previewMerge}
					>Preview conflicts and impact</button
				>{#if mergePreview}<div class="merge-preview">
						<h3>{mergePreview.source.name} → {mergePreview.target.name}</h3>
						<pre>{JSON.stringify(mergePreview.conflicts, null, 2)}</pre>
						<p class="small muted">{mergePreview.ledgerPolicy}</p>
						<dl class="details-list">
							{#each Object.entries(mergePreview.referenceCounts) as [key, value]}<div>
									<dt>{key}</dt>
									<dd>{String(value)}</dd>
								</div>{/each}
						</dl>
						<button class="primary" disabled={saving} onclick={commitMerge}
							>Confirm reviewed merge <Check size={16} /></button
						>
					</div>{/if}
			{:else if modal === 'send-preview'}<p>
					Review exactly who will receive this message. No email has been queued yet.
				</p>
				<dl class="details-list">
					<div>
						<dt>Subject</dt>
						<dd>{emailPreview.subject}</dd>
					</div>
					<div>
						<dt>From</dt>
						<dd>{emailPreview.from}</dd>
					</div>
					<div>
						<dt>Eligible recipients</dt>
						<dd>{emailPreview.count}</dd>
					</div>
					<div>
						<dt>SES send rate</dt>
						<dd>{emailPreview.quota?.maxSendRate} / second</dd>
					</div>
					<div>
						<dt>Quota remaining</dt>
						<dd>{emailPreview.quota?.remaining24Hour} / 24 hours</dd>
					</div>
				</dl>
				<div class="recipient-preview">
					{#each emailPreview.recipients || [] as recipient}<p>
							<strong>{recipient.name}</strong><span>{recipient.email}</span>
						</p>{/each}
				</div>
				<p class="small muted">
					Provider usage charges may apply. Consent and suppression will be rechecked before each
					send. Approval expires in 10 minutes.
				</p>
				<label class="checkbox-label"
					><input type="checkbox" bind:checked={sendApproved} />I approve sending this exact message
					to these {emailPreview.count} recipients.</label
				><button
					class="primary"
					disabled={saving || !sendApproved || !emailPreview.previewToken}
					onclick={approveSend}>Queue approved messages <Send size={16} /></button
				>
			{:else if modal === 'report-export'}<p>
					This download contains {reportData.eventIds.length} immutable financial event references for
					the current date and campaign filters. It includes transaction amounts and internal IDs.
				</p>
				<p class="small muted">{reportData.definition}</p>
				<div class="dialog-actions">
					<button class="secondary" onclick={() => (modal = '')}>Cancel</button><button
						class="primary"
						onclick={downloadReport}>Download reviewed CSV <Download size={16} /></button
					>
				</div>
			{:else if modal === 'archive'}<p>
					Archive {form.name}? Gift history and audit records will be retained. This person will
					leave the active contact list.
				</p>
				<div class="button-group">
					<button class="secondary" onclick={() => (modal = '')}>Keep person</button><button
						class="primary"
						disabled={saving}
						onclick={async () => {
							if (await mutate('contacts', form, 'archive')) {
								modal = '';
								goto(base + '/contacts');
							}
						}}>Archive person</button
					>
				</div>
			{:else if modal === 'provider'}<form
					class="stacked-form"
					onsubmit={(e) => {
						e.preventDefault();
						saveProvider();
					}}
				>
					<p class="small muted">
						Credentials are encrypted server-side. Requires HTTPS in production. Demo mode rejects
						credentials.
					</p>
					<label
						>Provider<select bind:value={providerForm.provider}
							><option value="openai">OpenAI API</option><option value="ses">AWS SES</option
							></select
						></label
					>{#if providerForm.provider === 'openai'}<label
							>Provider API key<input
								required
								type="password"
								autocomplete="new-password"
								bind:value={providerForm.apiKey}
							/></label
						><label>Model<input required bind:value={providerForm.model} /></label>{:else}<label
							>AWS region<input required bind:value={providerForm.region} /></label
						><label
							>Verified sender email<input
								required
								type="email"
								bind:value={providerForm.fromAddress}
							/></label
						><label
							>Access key ID<input
								required
								autocomplete="off"
								bind:value={providerForm.accessKeyId}
							/></label
						><label
							>Secret access key<input
								required
								type="password"
								autocomplete="new-password"
								bind:value={providerForm.secretAccessKey}
							/></label
						>{/if}<label class="checkbox-label"
						><input type="checkbox" bind:checked={providerForm.enabled} /> Enable this configured provider</label
					><button class="primary" disabled={saving || workspace?.tenant.demo}
						>Save encrypted configuration</button
					>
				</form>
			{:else}<form
					class="stacked-form"
					onsubmit={(e) => {
						e.preventDefault();
						save();
					}}
				>
					{#if ['contacts', 'campaigns', 'prospects', 'automations', 'organizations', 'households', 'segments', 'events'].includes(modal)}<label
							>{modal === 'contacts'
								? 'Full name'
								: modal === 'prospects'
									? 'Person or organization'
									: 'Name'}<input required maxlength="180" bind:value={form.name} /></label
						>{/if}
					{#if modal === 'contacts'}<label
							>Email address<input
								type="email"
								bind:value={form.email}
								placeholder="name@example.org"
							/></label
						>
						<div class="field-pair">
							<label
								>Relationship stage<select bind:value={form.stage}
									><option value="">Choose a stage</option
									>{#each ['First-time', 'Recurring', 'Sustainer', 'Major donor', 'Leadership circle', 'Volunteer', 'Lapsed'] as stage}<option
											>{stage}</option
										>{/each}</select
								></label
							><label>Source<input bind:value={form.source} placeholder="Community event" /></label>
						</div>
						<label
							>Tags <span class="muted">(comma separated)</span><input
								bind:value={form.tagText}
								placeholder={form.tags?.join(', ') || 'garden, board, volunteer'}
							/></label
						><label class="checkbox-label"
							><input type="checkbox" bind:checked={form.consent} /> Explicit marketing opt-in recorded</label
						>
					{:else if modal === 'gifts'}<div class="field-pair">
							<label
								>Gift amount (USD)<input
									required
									type="number"
									min="0.01"
									step="0.01"
									bind:value={form.amount}
									placeholder="100.00"
								/></label
							><label
								>Gift type<select bind:value={form.kind}
									><option value="one_time">One-time offline gift</option><option value="recurring"
										>Recorded recurring gift</option
									><option value="pledge">Pledge</option><option value="in_kind">In-kind</option
									></select
								></label
							>
						</div>
						<label
							>From<select bind:value={form.contactId}
								><option value="">Anonymous / unassigned</option
								>{#each workspace?.contacts || [] as contact}<option value={contact.id}
										>{contact.name}</option
									>{/each}</select
							></label
						><label
							>Campaign<select bind:value={form.campaignId}
								><option value="">General fund</option
								>{#each workspace?.campaigns || [] as campaign}<option value={campaign.id}
										>{campaign.name}</option
									>{/each}</select
							></label
						>
						<p class="small muted">
							Records an immutable offline entry. No card is charged, payment initiated, or receipt
							email sent.
						</p>
					{:else if modal === 'campaigns'}<label
							>Goal (USD)<input
								required
								type="number"
								min="0"
								step="1"
								bind:value={form.goal}
							/></label
						><label
							>The story<textarea
								rows="4"
								bind:value={form.description}
								placeholder="What becomes possible when people give?"></textarea></label
						><label>Target date<input type="date" bind:value={form.endsAt} /></label>
						<p class="small muted">
							Saved as a draft. Publishing and live payment require Stripe and validated terms.
						</p>
					{:else if modal === 'tasks'}<label
							>Task title<input required maxlength="240" bind:value={form.title} /></label
						>
						<div class="field-pair">
							<label>Due date<input type="date" bind:value={form.dueAt} /></label><label
								>Priority<select bind:value={form.priority}
									><option value="normal">Normal</option><option value="high">High</option><option
										value="low">Low</option
									></select
								></label
							>
						</div>
						<label
							>Linked person<select bind:value={form.contactId}
								><option value="">Workspace task</option
								>{#each workspace?.contacts || [] as contact}<option value={contact.id}
										>{contact.name}</option
									>{/each}</select
							></label
						>
					{:else if modal === 'activities'}<label
							>Note<textarea required rows="6" maxlength="5000" bind:value={form.summary}
							></textarea></label
						>
					{:else if modal === 'prospects'}<label
							>Why this candidate?<textarea rows="3" bind:value={form.reason}></textarea></label
						><label
							>Stage<select bind:value={form.stage}
								><option value="discovered">Discovered</option><option value="screened"
									>Screened</option
								><option value="qualified">Qualified</option></select
							></label
						>
						<p class="small muted">
							Add source evidence before making outreach decisions. No contact permission is
							implied.
						</p>
					{:else if modal === 'introductions'}<label
							>Existing supporter<select required bind:value={form.contactId}
								><option value="">Choose a person</option
								>{#each workspace?.contacts || [] as contact}<option value={contact.id}
										>{contact.name}</option
									>{/each}</select
							></label
						><label
							>Research candidate<select required bind:value={form.prospectId}
								><option value="">Choose a prospect</option
								>{#each workspace?.prospects || [] as prospect}<option value={prospect.id}
										>{prospect.name}</option
									>{/each}</select
							></label
						><label
							>Thoughtful next step<textarea rows="3" bind:value={form.nextStep}></textarea></label
						>
						<p class="small muted">
							Starts internal review. Ask your supporter to confirm acquaintance and consent before
							proceeding.
						</p>
					{:else if modal === 'emails'}<label
							>Subject<input required maxlength="300" bind:value={form.subject} /></label
						><label>Your message<textarea rows="7" bind:value={form.body}></textarea></label>
						<p class="small muted">Saved as a draft. No email is sent.</p>
					{:else if modal === 'automations'}<label
							>Trigger<select bind:value={form.trigger}
								><option value="gift.received">Gift received</option><option value="contact.created"
									>Contact created</option
								><option value="manual">Manual review</option></select
							></label
						>
						<p class="banner neutral">Draft, simulation only. Live execution is not enabled.</p>
					{:else if modal === 'organizations'}<label
							>Organization type<select bind:value={form.type}
								><option value="Foundation">Foundation</option><option value="Nonprofit"
									>Nonprofit</option
								><option value="Business">Business</option><option value="School">School</option
								></select
							></label
						><label>Website<input type="url" bind:value={form.website} /></label>
					{:else if modal === 'households'}<fieldset>
							<legend>Household members</legend><ContactPicker
								{tenant}
								bind:contactId={householdMemberToAdd}
								label="Find a household member"
								onSelect={(contact) => {
									if (contact) {
										form.memberIds = [...new Set([...(form.memberIds || []), contact.id])];
										if (workspace && !workspace.contacts.some((c) => c.id === contact.id))
											workspace = { ...workspace, contacts: [...workspace.contacts, contact] };
										householdMemberToAdd = '';
									}
								}}
							/>{#each workspace?.contacts || [] as contact}<label class="checkbox-label"
									><input
										type="checkbox"
										value={contact.id}
										bind:group={form.memberIds}
									/>{contact.name}</label
								>{/each}
						</fieldset>
					{:else if modal === 'segments'}<label
							>Contact field<select bind:value={form.ruleField}
								><option value="stage">Stage</option><option value="source">Source</option><option
									value="name">Name</option
								><option value="email">Email</option><option value="tags">Tags</option></select
							></label
						><label
							>Match<select bind:value={form.ruleOperator}
								><option value="equals">Equals</option><option value="contains">Contains</option
								><option value="is_empty">Is empty</option></select
							></label
						><label>Value<input bind:value={form.ruleValue} /></label>
					{:else if modal === 'events'}<label
							>Date<input type="date" bind:value={form.date} /></label
						><label>Capacity<input type="number" min="1" bind:value={form.capacity} /></label><label
							>Description<textarea rows="3" bind:value={form.description}></textarea></label
						>
						<p class="small muted">
							Creates an internal event record. Public registration and payment are not enabled.
						</p>
					{:else if modal === 'relationships'}<label
							>From supporter<select required bind:value={form.fromId}
								><option value="">Choose a supporter</option
								>{#each workspace?.contacts || [] as contact}<option value={contact.id}
										>{contact.name}</option
									>{/each}</select
							></label
						><label
							>To prospect<select required bind:value={form.toId}
								><option value="">Choose a prospect</option
								>{#each workspace?.prospects || [] as prospect}<option value={prospect.id}
										>{prospect.name}</option
									>{/each}</select
							></label
						><label
							>Relationship type<select bind:value={form.kind}
								><option value="serves_on_board">Shared board affiliation</option><option
									value="works_at">Works at</option
								><option value="donor_confirmed_connection">Donor-confirmed connection</option
								></select
							></label
						><label
							>Evidence and source<textarea required bind:value={form.evidence} rows="3"
							></textarea></label
						><label
							>Confidence<select bind:value={form.confidence}
								><option value="possible">Possible — needs review</option><option value="confirmed"
									>Confirmed with evidence</option
								></select
							></label
						>
					{/if}
					<div class="dialog-actions">
						<button type="button" class="secondary" onclick={() => (modal = '')} disabled={saving}
							>Cancel</button
						><button class="primary" disabled={saving}
							>{saving
								? 'Saving…'
								: editId
									? 'Save changes'
									: modal === 'gifts'
										? 'Record offline gift'
										: 'Save ' +
											(
												{
													contacts: 'person',
													campaigns: 'campaign',
													tasks: 'task',
													activities: 'note',
													prospects: 'prospect',
													introductions: 'proposal',
													emails: 'draft',
													automations: 'workflow',
													relationships: 'evidence',
													organizations: 'organization',
													households: 'household',
													segments: 'segment',
													events: 'event'
												} as Record<string, string>
											)[modal]}<Check size={16} /></button
						>
					</div>
				</form>{/if}
		</div>
	</div>{/if}
