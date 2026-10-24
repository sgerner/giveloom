import {
	boolean,
	char,
	integer,
	jsonb,
	pgTable,
	primaryKey,
	text,
	timestamp,
	uuid,
	bigint,
	numeric,
	uniqueIndex
} from 'drizzle-orm/pg-core';

export const tenants = pgTable('tenants', {
	id: uuid('id').defaultRandom().primaryKey(),
	slug: text('slug').notNull().unique(),
	legalName: text('legal_name').notNull(),
	timezone: text('timezone').notNull().default('UTC'),
	locale: text('locale').notNull().default('en-US'),
	currency: char('currency', { length: 3 }).notNull().default('USD'),
	branding: jsonb('branding').notNull().default({}),
	featureFlags: jsonb('feature_flags').notNull().default({}),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
});
export const users = pgTable('users', {
	id: uuid('id').defaultRandom().primaryKey(),
	email: text('email').notNull().unique(),
	displayName: text('display_name').notNull(),
	passwordHash: text('password_hash').notNull(),
	emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),
	disabledAt: timestamp('disabled_at', { withTimezone: true }),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
});
export const memberships = pgTable(
	'memberships',
	{
		tenantId: uuid('tenant_id')
			.notNull()
			.references(() => tenants.id),
		userId: uuid('user_id')
			.notNull()
			.references(() => users.id),
		role: text('role').notNull(),
		status: text('status').notNull().default('active'),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
	},
	(table) => [primaryKey({ columns: [table.tenantId, table.userId] })]
);
export const contacts = pgTable(
	'contacts',
	{
		id: uuid('id').notNull().defaultRandom(),
		tenantId: uuid('tenant_id')
			.notNull()
			.references(() => tenants.id),
		name: text('name').notNull(),
		email: text('email'),
		stage: text('stage').notNull().default('new'),
		tags: text('tags').array().notNull().default([]),
		data: jsonb('data').notNull().default({}),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
		archivedAt: timestamp('archived_at', { withTimezone: true })
	},
	(table) => [
		primaryKey({ columns: [table.tenantId, table.id] }),
		uniqueIndex('contacts_tenant_email_uq').on(table.tenantId, table.email)
	]
);
export const contactMethods = pgTable(
	'contact_methods',
	{
		id: uuid('id').notNull().defaultRandom(),
		tenantId: uuid('tenant_id').notNull(),
		contactId: uuid('contact_id').notNull(),
		kind: text('kind').notNull(),
		value: text('value').notNull(),
		normalizedValue: text('normalized_value').notNull(),
		preferred: boolean('preferred').notNull().default(false)
	},
	(table) => [primaryKey({ columns: [table.tenantId, table.id] })]
);
export const campaigns = pgTable(
	'campaigns',
	{
		id: uuid('id').notNull().defaultRandom(),
		tenantId: uuid('tenant_id')
			.notNull()
			.references(() => tenants.id),
		name: text('name').notNull(),
		goalMinor: bigint('goal_minor', { mode: 'number' }).notNull().default(0),
		currency: char('currency', { length: 3 }).notNull().default('USD'),
		status: text('status').notNull().default('draft'),
		data: jsonb('data').notNull().default({}),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
	},
	(table) => [primaryKey({ columns: [table.tenantId, table.id] })]
);
export const gifts = pgTable(
	'gifts',
	{
		id: uuid('id').notNull().defaultRandom(),
		tenantId: uuid('tenant_id')
			.notNull()
			.references(() => tenants.id),
		contactId: uuid('contact_id'),
		campaignId: uuid('campaign_id'),
		amountMinor: bigint('amount_minor', { mode: 'number' }).notNull(),
		currency: char('currency', { length: 3 }).notNull(),
		kind: text('kind').notNull().default('one_time'),
		status: text('status').notNull().default('recorded'),
		occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
		correctionOf: uuid('correction_of'),
		data: jsonb('data').notNull().default({}),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
	},
	(table) => [primaryKey({ columns: [table.tenantId, table.id] })]
);
export const prospects = pgTable(
	'prospects',
	{
		id: uuid('id').notNull().defaultRandom(),
		tenantId: uuid('tenant_id')
			.notNull()
			.references(() => tenants.id),
		name: text('name').notNull(),
		stage: text('stage').notNull().default('discovered'),
		score: numeric('score', { precision: 5, scale: 2 }),
		matchStatus: text('match_status').notNull().default('possible'),
		data: jsonb('data').notNull().default({}),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
	},
	(table) => [primaryKey({ columns: [table.tenantId, table.id] })]
);
export const prospectEvidence = pgTable(
	'prospect_evidence',
	{
		id: uuid('id').notNull().defaultRandom(),
		tenantId: uuid('tenant_id').notNull(),
		prospectId: uuid('prospect_id').notNull(),
		sourceName: text('source_name').notNull(),
		sourceUrl: text('source_url'),
		evidenceType: text('evidence_type').notNull(),
		confidence: text('confidence').notNull(),
		observedAt: timestamp('observed_at', { withTimezone: true }),
		license: text('license'),
		data: jsonb('data').notNull().default({})
	},
	(table) => [primaryKey({ columns: [table.tenantId, table.id] })]
);
export const workspaceRecords = pgTable(
	'workspace_records',
	{
		tenantId: uuid('tenant_id')
			.notNull()
			.references(() => tenants.id),
		resource: text('resource').notNull(),
		id: uuid('id').notNull().defaultRandom(),
		data: jsonb('data').notNull(),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
		archivedAt: timestamp('archived_at', { withTimezone: true })
	},
	(table) => [primaryKey({ columns: [table.tenantId, table.resource, table.id] })]
);
export const activities = pgTable(
	'activities',
	{
		id: uuid('id').notNull().defaultRandom(),
		tenantId: uuid('tenant_id')
			.notNull()
			.references(() => tenants.id),
		contactId: uuid('contact_id'),
		kind: text('kind').notNull(),
		summary: text('summary').notNull(),
		occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
		actorId: uuid('actor_id'),
		data: jsonb('data').notNull().default({})
	},
	(table) => [primaryKey({ columns: [table.tenantId, table.id] })]
);
export const tasks = pgTable(
	'tasks',
	{
		id: uuid('id').notNull().defaultRandom(),
		tenantId: uuid('tenant_id')
			.notNull()
			.references(() => tenants.id),
		contactId: uuid('contact_id'),
		title: text('title').notNull(),
		dueAt: timestamp('due_at', { withTimezone: true }),
		priority: text('priority').notNull().default('normal'),
		status: text('status').notNull().default('open'),
		data: jsonb('data').notNull().default({}),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
	},
	(table) => [primaryKey({ columns: [table.tenantId, table.id] })]
);
export const outboxEvents = pgTable('outbox_events', {
	id: uuid('id').defaultRandom().primaryKey(),
	tenantId: uuid('tenant_id')
		.notNull()
		.references(() => tenants.id),
	eventType: text('event_type').notNull(),
	payload: jsonb('payload').notNull(),
	idempotencyKey: text('idempotency_key').notNull().unique(),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
	processedAt: timestamp('processed_at', { withTimezone: true }),
	attempts: integer('attempts').notNull().default(0),
	lastError: text('last_error')
});
export const auditLog = pgTable('audit_log', {
	id: uuid('id').defaultRandom().primaryKey(),
	tenantId: uuid('tenant_id')
		.notNull()
		.references(() => tenants.id),
	actorId: uuid('actor_id'),
	action: text('action').notNull(),
	resource: text('resource').notNull(),
	recordId: uuid('record_id'),
	details: jsonb('details').notNull().default({}),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
});
