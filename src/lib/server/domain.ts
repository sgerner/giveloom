import { z } from 'zod';

export const resources = [
	'contacts',
	'gifts',
	'campaigns',
	'tasks',
	'prospects',
	'introductions',
	'emails',
	'automations',
	'activities',
	'relationships',
	'organizations',
	'households',
	'segments',
	'events',
	'settings'
] as const;
export type Resource = (typeof resources)[number];

const id = z.string().uuid().optional();
const base = z
	.object({ id, createdAt: z.string().optional(), updatedAt: z.string().optional() })
	.passthrough();
const schemas: Record<Exclude<Resource, 'settings'>, z.ZodTypeAny> = {
	contacts: base.extend({
		name: z.string().min(1).max(180),
		email: z.string().email().optional().or(z.literal('')),
		stage: z.string().optional(),
		tags: z.array(z.string()).optional()
	}),
	gifts: base
		.extend({
			contactId: z.string().uuid().optional(),
			amountMinor: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
			currency: z.string().length(3).default('USD'),
			kind: z
				.enum(['one_time', 'recurring', 'pledge', 'in_kind', 'correction'])
				.default('one_time'),
			status: z
				.enum(['recorded', 'pledged', 'pending_manual_review', 'refunded', 'failed'])
				.default('recorded'),
			correctionOf: z.string().uuid().optional(),
			correctionReason: z.string().max(1000).optional()
		})
		.superRefine((gift, ctx) => {
			if (gift.kind === 'correction' && (!gift.correctionOf || !gift.correctionReason))
				ctx.addIssue({
					code: 'custom',
					message: 'Gift corrections require the original gift ID and a reason.'
				});
		}),
	campaigns: base.extend({
		name: z.string().min(1).max(180),
		goalMinor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
		currency: z.string().length(3).default('USD'),
		status: z.string().optional()
	}),
	tasks: base.extend({
		title: z.string().min(1).max(240),
		contactId: z.string().uuid().optional(),
		dueAt: z.string().optional(),
		status: z.string().optional(),
		priority: z.string().optional()
	}),
	prospects: base.extend({
		name: z.string().min(1).max(180),
		stage: z.string().optional(),
		score: z.number().min(0).max(100).optional(),
		evidence: z
			.array(
				z.object({
					sourceName: z.string(),
					sourceUrl: z.string().url().optional(),
					observedAt: z.string().optional(),
					confidence: z.string().optional()
				})
			)
			.optional()
	}),
	introductions: base.extend({
		prospectId: z.string().uuid().optional(),
		contactId: z.string().uuid().optional(),
		stage: z
			.enum([
				'proposed',
				'internal_review',
				'donor_asked',
				'donor_consented',
				'draft_prepared',
				'sent_by_donor',
				'meeting',
				'qualified',
				'donated',
				'closed'
			])
			.optional()
	}),
	emails: base.extend({
		contactId: z.string().uuid().optional(),
		subject: z.string().max(300).optional(),
		body: z.string().max(100_000).optional(),
		htmlBody: z.string().max(100_000).optional(),
		segmentId: z.string().uuid().nullable().optional(),
		templateId: z.string().uuid().optional(),
		preheader: z.string().max(180).optional(),
		consent: z.boolean().optional(),
		status: z.enum(['draft', 'review']).default('draft')
	}),
	automations: base.extend({
		name: z.string().min(1).max(180),
		status: z.enum(['draft', 'paused']).optional(),
		steps: z.array(z.unknown()).optional()
	}),
	activities: base.extend({ kind: z.string(), summary: z.string().max(5000) }),
	relationships: base.extend({
		fromId: z.string().uuid(),
		toId: z.string().uuid(),
		kind: z.string(),
		evidence: z.string().min(1),
		confidence: z.enum(['confirmed', 'high', 'medium', 'low', 'possible']).optional()
	}),
	organizations: base.extend({
		name: z.string().min(1).max(180),
		website: z.string().url().optional().or(z.literal('')),
		type: z.string().max(80).optional()
	}),
	households: base.extend({
		name: z.string().min(1).max(180),
		memberIds: z.array(z.string().uuid()).max(500)
	}),
	segments: base.extend({
		name: z.string().min(1).max(180),
		rules: z
			.array(
				z.object({
					field: z.string().min(1).max(80),
					operator: z.enum(['equals', 'contains', 'greater_than', 'less_than', 'is_empty']),
					value: z.unknown().optional()
				})
			)
			.max(50)
	}),
	events: base.extend({
		name: z.string().min(1).max(180),
		date: z.string().max(80).optional(),
		capacity: z.number().int().positive().optional(),
		description: z.string().max(5000).optional()
	})
};

export const settingsSchema = z
	.object({
		organizationName: z.string().max(180).optional(),
		currency: z.string().length(3).optional(),
		timeZone: z.string().max(80).optional(),
		locale: z.string().max(20).optional(),
		theme: z.string().max(40).optional()
	})
	.passthrough();
export const mutationSchema = z.object({
	tenant: z.string().min(1),
	resource: z.enum(resources),
	data: z.record(z.string(), z.unknown()),
	action: z.enum(['create', 'update', 'archive', 'simulate']).optional()
});

export function validateResource(resource: Resource, data: unknown) {
	const parsed =
		resource === 'settings' ? settingsSchema.parse(data) : schemas[resource].parse(data);
	const allowedRelations: Partial<Record<Resource, string[]>> = {
		gifts: ['contactId', 'campaignId', 'correctionOf'],
		tasks: ['contactId'],
		activities: ['contactId'],
		introductions: ['contactId', 'prospectId'],
		emails: ['contactId', 'segmentId', 'templateId'],
		relationships: ['fromId', 'toId'],
		households: ['memberIds']
	};
	const inspect = (value: unknown, root = false): string | undefined => {
		if (Array.isArray(value)) return value.map((item) => inspect(item)).find(Boolean);
		if (!value || typeof value !== 'object') return undefined;
		for (const [key, nested] of Object.entries(value)) {
			if (/^(tenant_?id|actor_?id|user_?id|created_?at|updated_?at)$/i.test(key)) return key;
			if (
				root &&
				/(?:Id|_id)$/i.test(key) &&
				key !== 'id' &&
				!allowedRelations[resource]?.includes(key)
			)
				return key;
			if (/(?:password|secret|token|api.?key|private.?key)/i.test(key)) return key;
			const result = inspect(nested);
			if (result) return result;
		}
		return undefined;
	};
	const blockedField = inspect(parsed, true);
	if (blockedField)
		throw new Error(
			`The ${blockedField} field is managed by the server or cannot be stored through the workspace API.`
		);
	return parsed;
}

/** Fail closed rather than rounding PostgreSQL bigint values when exposing minor-unit amounts as JS numbers. */
export function safeMinorUnits(value: unknown, field = 'amount'): number {
	const parsed =
		typeof value === 'number'
			? value
			: typeof value === 'string' && /^\d+$/.test(value)
				? Number(value)
				: NaN;
	if (!Number.isSafeInteger(parsed) || parsed < 0)
		throw new Error(`${field} exceeds the supported integer range.`);
	return parsed;
}

export function redactWorkspaceValue<T>(
	value: T,
	options: { directContact: boolean; wealth: boolean; sensitiveNotes: boolean; gift?: boolean }
): T {
	const directKeys = new Set([
		'email',
		'phone',
		'mobile',
		'address',
		'mailingaddress',
		'streetaddress',
		'postalcode',
		'zipcode',
		'contactemail',
		'donoremail',
		'contactname',
		'donorname',
		'firstname',
		'lastname',
		'birthdate',
		'dateofbirth',
		'ssn',
		'taxid',
		'nationalid'
	]);
	const wealthKeys = new Set([
		'wealthestimate',
		'wealthproxy',
		'givingcapacity',
		'capacityrating',
		'estimatedcapacity',
		'estimatedgivingcapacity',
		'networth',
		'assetsestimate'
	]);
	const noteKeys = new Set([
		'note',
		'notes',
		'sensitivenotes',
		'privatenotes',
		'notesprivate',
		'confidentialnotes'
	]);
	const visit = (entry: unknown): unknown => {
		if (Array.isArray(entry)) return entry.map(visit);
		if (!entry || typeof entry !== 'object') return entry;
		const result: Record<string, unknown> = {};
		for (const [key, nested] of Object.entries(entry as Record<string, unknown>)) {
			const normalized = key.toLowerCase().replace(/[_-]/g, '');
			const directField =
				directKeys.has(normalized) ||
				/(?:email|phone|mobile|address|postalcode|zipcode)$/.test(normalized);
			const wealthField =
				wealthKeys.has(normalized) ||
				/(?:wealthestimate|wealthproxy|givingcapacity|capacityrating|networth)$/.test(normalized);
			const noteField = noteKeys.has(normalized) || /notes?$/.test(normalized);
			if (
				(!options.directContact && directField) ||
				(!options.wealth && wealthField) ||
				(!options.sensitiveNotes && noteField) ||
				(options.gift && !options.directContact && normalized === 'contactid')
			)
				continue;
			result[key] = visit(nested);
		}
		return result;
	};
	return visit(value) as T;
}

export function redactWorkspaceRecord<T>(role: string, resource: Resource, value: T): T {
	return redactWorkspaceValue(value, {
		directContact: [
			'owner',
			'admin',
			'finance_manager',
			'finance',
			'fundraising_manager',
			'fundraiser',
			'marketer',
			'analyst'
		].includes(role),
		wealth: ['owner', 'admin', 'fundraising_manager', 'fundraiser'].includes(role),
		sensitiveNotes: ['owner', 'admin'].includes(role),
		gift: resource === 'gifts'
	});
}

export const contactImportRowSchema = z
	.object({
		name: z.string().trim().min(1).max(180),
		email: z.string().trim().email().optional().or(z.literal('')),
		phone: z.string().trim().max(80).optional(),
		stage: z.string().trim().max(80).optional(),
		tags: z.string().trim().max(500).optional()
	})
	.strict();

export type Workspace = {
	tenant: {
		id: string;
		slug: string;
		name: string;
		currency: string;
		timeZone: string;
		demo: boolean;
	};
	user: { id: string; email: string; name: string; role: string };
	memberships: Array<{
		id: string;
		slug: string;
		name: string;
		currency: string;
		timeZone: string;
		role: string;
	}>;
	contacts: Record<string, unknown>[];
	gifts: Record<string, unknown>[];
	campaigns: Record<string, unknown>[];
	tasks: Record<string, unknown>[];
	prospects: Record<string, unknown>[];
	introductions: Record<string, unknown>[];
	emails: Record<string, unknown>[];
	automations: Record<string, unknown>[];
	activities: Record<string, unknown>[];
	relationships: Record<string, unknown>[];
	overview?: {
		bounded: boolean;
		contactLimit: number;
		contactCount: number;
		giftEventCount: number;
		grossMinor: number;
		refundMinor: number;
		disputeMinor: number;
		reinstatementMinor: number;
		netRecordedMinor: number;
		pledgedMinor: number;
		recurringMinor: number;
		recurringCount: number;
		byMonth: { month: string; amountMinor: number }[];
		recentGifts: Record<string, unknown>[];
		campaignGiving: Record<string, number>;
	};
	settings: Record<string, unknown>;
	organizations: Record<string, unknown>[];
	households: Record<string, unknown>[];
	segments: Record<string, unknown>[];
	events: Record<string, unknown>[];
	contactAliases?: Array<{ id: string; name: string; mergedInto: string }>;
};

const rolePermissions: Record<string, Set<Resource>> = {
	owner: new Set(resources),
	admin: new Set(resources),
	finance_manager: new Set(['contacts', 'gifts', 'campaigns', 'tasks', 'activities', 'settings']),
	fundraising_manager: new Set([
		'contacts',
		'campaigns',
		'tasks',
		'prospects',
		'introductions',
		'emails',
		'automations',
		'activities',
		'relationships',
		'organizations',
		'households',
		'segments',
		'events'
	]),
	fundraiser: new Set([
		'contacts',
		'campaigns',
		'tasks',
		'prospects',
		'introductions',
		'emails',
		'activities',
		'relationships',
		'organizations',
		'households',
		'segments',
		'events'
	]),
	marketer: new Set([
		'contacts',
		'campaigns',
		'tasks',
		'emails',
		'activities',
		'organizations',
		'segments',
		'events'
	]),
	finance: new Set(['contacts', 'gifts', 'campaigns', 'tasks', 'activities', 'settings']),
	donor: new Set(),
	analyst: new Set(),
	volunteer: new Set(),
	board_member: new Set(),
	read_only: new Set()
};
export function assertRoleCanMutate(
	role: string,
	resource: Resource,
	action: 'create' | 'update' | 'archive' | 'simulate'
) {
	if (resource === 'gifts' && !['owner', 'admin', 'finance_manager', 'finance'].includes(role))
		throw Object.assign(
			new Error('Recording gift events requires a finance manager or administrator.'),
			{ status: 403 }
		);
	if (!rolePermissions[role]?.has(resource))
		throw Object.assign(
			new Error(`Your ${role.replaceAll('_', ' ')} role cannot change ${resource}.`),
			{ status: 403 }
		);
	if (resource === 'gifts' && action !== 'create')
		throw Object.assign(
			new Error('Gift events are immutable; record a correction as a new gift event.'),
			{ status: 422 }
		);
	if (resource === 'automations' && action !== 'simulate' && role !== 'owner' && role !== 'admin')
		throw Object.assign(new Error('Only an owner or admin can change automation configuration.'), {
			status: 403
		});
	if (action === 'simulate' && resource !== 'automations')
		throw Object.assign(new Error('Simulation is only available for automations.'), {
			status: 422
		});
}
