import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Pool, PoolClient } from 'pg';
import { getPool, workspaceFromPostgres } from './database';
import { generateWorkflowEmailDraft } from './ai-assistant';
import { segmentMatches } from './communications';

export type AutomationSession = App.Locals['session'];
export type AutomationOutboxEvent = {
	id?: string;
	tenantId: string;
	eventType: string;
	payload: unknown;
	idempotencyKey?: string;
};
const manageRoles = new Set(['owner', 'admin', 'fundraising_manager']);

export class AutomationError extends Error {
	constructor(
		message: string,
		readonly status: number
	) {
		super(message);
		this.name = 'AutomationError';
	}
}

const triggerSchema = z.discriminatedUnion('type', [
	z
		.object({
			type: z.enum([
				'gift.recorded',
				'first_gift',
				'recurring_gift_failed',
				'donation_anniversary',
				'contact.created',
				'task.completed',
				'manual'
			])
		})
		.strict(),
	z.object({ type: z.literal('contact.tagged'), tag: z.string().trim().min(1).max(80) }).strict(),
	z
		.object({ type: z.enum(['segment.entry', 'segment.exit']), segmentId: z.string().uuid() })
		.strict(),
	z
		.object({
			type: z.literal('pledge.overdue'),
			daysOverdue: z.number().int().min(0).max(365).default(1)
		})
		.strict(),
	z
		.object({ type: z.literal('form.submitted'), formId: z.string().trim().min(1).max(120) })
		.strict(),
	z
		.object({
			type: z.literal('email.engagement'),
			engagement: z.enum(['delivered', 'opened', 'clicked'])
		})
		.strict(),
	z
		.object({ type: z.literal('inactivity'), days: z.number().int().min(1).max(3650).default(180) })
		.strict(),
	z
		.object({ type: z.literal('prospect.score_threshold'), threshold: z.number().min(0).max(100) })
		.strict(),
	z
		.object({
			type: z.literal('birthday'),
			fieldId: z.string().uuid(),
			requireConsent: z.literal(true).default(true)
		})
		.strict(),
	z
		.object({
			type: z.literal('schedule'),
			intervalMinutes: z.number().int().min(15).max(525600),
			startAt: z.string().datetime().optional()
		})
		.strict()
]);
const nodeSchema = z.discriminatedUnion('type', [
	z.object({ id: z.string().regex(/^[a-zA-Z0-9_-]{1,60}$/), type: z.literal('exit') }).strict(),
	z
		.object({
			id: z.string().regex(/^[a-zA-Z0-9_-]{1,60}$/),
			type: z.literal('wait'),
			minutes: z.number().int().min(1).max(525600),
			next: z.string().regex(/^[a-zA-Z0-9_-]{1,60}$/)
		})
		.strict(),
	z
		.object({
			id: z.string().regex(/^[a-zA-Z0-9_-]{1,60}$/),
			type: z.literal('condition'),
			field: z.enum([
				'gift.amountMinor',
				'gift.lifetimeGivingMinor',
				'gift.kind',
				'gift.status',
				'contact.stage',
				'contact.consent',
				'contact.tags',
				'contact.segmentIds',
				'contact.timeSinceLastGiftDays',
				'contact.assignedOfficerId',
				'contact.source',
				'contact.relationshipConfidence',
				'task.status',
				'prospect.score'
			]),
			operator: z.enum([
				'equals',
				'not_equals',
				'greater_than',
				'greater_or_equal',
				'less_than',
				'less_or_equal',
				'contains'
			]),
			value: z.union([z.string().max(180), z.number().finite(), z.boolean()]),
			whenTrue: z.string().regex(/^[a-zA-Z0-9_-]{1,60}$/),
			whenFalse: z.string().regex(/^[a-zA-Z0-9_-]{1,60}$/)
		})
		.strict(),
	z
		.object({
			id: z.string().regex(/^[a-zA-Z0-9_-]{1,60}$/),
			type: z.literal('action'),
			action: z.enum([
				'create_task',
				'notify',
				'add_tag',
				'update_stage',
				'update_field',
				'email',
				'email_draft',
				'ai_draft',
				'webhook'
			]),
			title: z.string().max(180).optional(),
			body: z.string().max(4000).optional(),
			tag: z.string().max(80).optional(),
			stage: z
				.enum(['new', 'prospect', 'active', 'lapsed', 'major_gift', 'do_not_contact'])
				.optional(),
			dueInHours: z.number().int().min(0).max(8760).optional(),
			subject: z.string().max(300).optional(),
			fieldId: z.string().uuid().optional(),
			value: z.unknown().optional(),
			endpointId: z.string().uuid().optional(),
			eventName: z.string().max(120).optional(),
			next: z
				.string()
				.regex(/^[a-zA-Z0-9_-]{1,60}$/)
				.optional()
		})
		.strict()
]);
export const workflowSchema = z
	.object({
		trigger: triggerSchema,
		startId: z.string().regex(/^[a-zA-Z0-9_-]{1,60}$/),
		nodes: z.array(nodeSchema).min(1).max(40),
		frequencyCapHours: z.number().int().min(0).max(8760).default(0),
		quietHours: z
			.object({
				start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
				end: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)
			})
			.strict()
			.optional()
	})
	.strict();
export type WorkflowDefinition = z.infer<typeof workflowSchema>;
type Node = WorkflowDefinition['nodes'][number];

function issue(message: string) {
	throw new AutomationError(message, 422);
}

export function validateWorkflowDefinition(input: unknown) {
	const parsed = workflowSchema.safeParse(input);
	if (!parsed.success)
		return {
			valid: false,
			issues: parsed.error.issues.map((x) => ({ path: x.path.join('.'), message: x.message }))
		};
	const workflow = parsed.data;
	const ids = new Set<string>();
	for (const node of workflow.nodes) {
		if (ids.has(node.id))
			return {
				valid: false,
				issues: [{ path: 'nodes', message: `Node id ${node.id} is duplicated.` }]
			};
		ids.add(node.id);
		if (node.type === 'action' && node.action === 'add_tag' && !node.tag?.trim())
			return {
				valid: false,
				issues: [{ path: `nodes.${node.id}.tag`, message: 'Add tag actions need a tag name.' }]
			};
		if (node.type === 'action' && node.action === 'update_stage' && !node.stage)
			return {
				valid: false,
				issues: [
					{ path: `nodes.${node.id}.stage`, message: 'Stage actions need a destination stage.' }
				]
			};
		if (
			node.type === 'action' &&
			node.action === 'update_field' &&
			(!node.fieldId || node.value === undefined)
		)
			return {
				valid: false,
				issues: [
					{
						path: `nodes.${node.id}`,
						message: 'Custom field actions need a field ID and JSON value.'
					}
				]
			};
		if (node.type === 'action' && node.action === 'webhook' && !node.endpointId)
			return {
				valid: false,
				issues: [
					{
						path: `nodes.${node.id}`,
						message: 'Webhook actions need an explicitly approved endpoint ID.'
					}
				]
			};
	}
	if (!ids.has(workflow.startId))
		return { valid: false, issues: [{ path: 'startId', message: 'The start node must exist.' }] };
	const edges = (node: Node) =>
		node.type === 'condition'
			? [node.whenTrue, node.whenFalse]
			: node.type === 'exit'
				? []
				: node.type === 'action'
					? node.next
						? [node.next]
						: []
					: [node.next];
	for (const node of workflow.nodes)
		for (const target of edges(node))
			if (!ids.has(target))
				return {
					valid: false,
					issues: [{ path: `nodes.${node.id}`, message: `Next node ${target} does not exist.` }]
				};
	const byId = new Map(workflow.nodes.map((node) => [node.id, node]));
	const visiting = new Set<string>();
	const visited = new Set<string>();
	let cycle = false;
	const visit = (id: string) => {
		if (visiting.has(id)) {
			cycle = true;
			return;
		}
		if (visited.has(id)) return;
		visiting.add(id);
		for (const next of edges(byId.get(id)!)) visit(next);
		visiting.delete(id);
		visited.add(id);
	};
	visit(workflow.startId);
	if (cycle)
		return {
			valid: false,
			issues: [
				{
					path: 'nodes',
					message:
						'Workflow loops are not allowed; connect back to an earlier step only by editing the draft into an acyclic flow.'
				}
			]
		};
	if (visited.size !== workflow.nodes.length)
		return {
			valid: false,
			issues: [{ path: 'nodes', message: 'Every node must be reachable from the start node.' }]
		};
	return {
		valid: true,
		issues: [] as Array<{ path: string; message: string }>,
		definition: workflow
	};
}

export function evaluateWorkflowCondition(
	node: Extract<Node, { type: 'condition' }>,
	context: Record<string, any>
) {
	const [scope, field] = node.field.split('.');
	const actual = context[scope!]?.[field!];
	const expected = node.value;
	switch (node.operator) {
		case 'equals':
			return actual === expected;
		case 'not_equals':
			return actual !== expected;
		case 'greater_than':
			return typeof actual === 'number' && typeof expected === 'number' && actual > expected;
		case 'greater_or_equal':
			return typeof actual === 'number' && typeof expected === 'number' && actual >= expected;
		case 'less_than':
			return typeof actual === 'number' && typeof expected === 'number' && actual < expected;
		case 'less_or_equal':
			return typeof actual === 'number' && typeof expected === 'number' && actual <= expected;
		case 'contains':
			return Array.isArray(actual)
				? actual.includes(expected)
				: typeof actual === 'string' && typeof expected === 'string' && actual.includes(expected);
	}
}

function mergeContactContext(context: Record<string, any>, row: Record<string, any>) {
	const confidence =
		row.relationshipConfidence === null || row.relationshipConfidence === undefined
			? null
			: Number(row.relationshipConfidence);
	return {
		...context,
		contact: {
			...(context.contact ?? {}),
			id: row.id,
			stage: row.stage,
			tags: row.tags,
			consent: row.data?.consent === true,
			source: row.data?.source ?? '',
			assignedOfficerId: row.data?.assignedOfficerId ?? null,
			segmentIds: Array.isArray(row.segmentIds)
				? row.segmentIds
				: Array.isArray(row.data?.segmentIds)
					? row.data.segmentIds
					: [],
			timeSinceLastGiftDays: row.daysSinceGift === null ? null : Number(row.daysSinceGift),
			relationshipConfidence: confidence
		},
		gift: { ...(context.gift ?? {}), lifetimeGivingMinor: Number(row.lifetimeGivingMinor ?? 0) }
	};
}

async function workflowContextForContact(
	client: PoolClient,
	tenantId: string,
	contactId: string,
	context: Record<string, any>
) {
	const result = await client.query(
		`SELECT c.id,c.stage,c.tags,c.data,
		COALESCE((SELECT sum(g.amount_minor) FROM gifts g WHERE g.tenant_id=c.tenant_id AND g.contact_id=c.id AND g.status='recorded' AND g.kind<>'correction'),0)::bigint AS "lifetimeGivingMinor",
		(SELECT extract(epoch FROM now()-max(g.occurred_at))/86400 FROM gifts g WHERE g.tenant_id=c.tenant_id AND g.contact_id=c.id AND g.status='recorded' AND g.kind<>'correction') AS "daysSinceGift",
		(SELECT max(CASE e.confidence WHEN 'confirmed' THEN 1.0 WHEN 'high' THEN .9 WHEN 'medium' THEN .65 WHEN 'low' THEN .35 ELSE .15 END) FROM graph_edges e WHERE e.tenant_id=c.tenant_id AND (e.from_id=c.id OR e.to_id=c.id) AND e.verification_status='verified' AND e.privacy_scope<>'restricted') AS "relationshipConfidence"
		FROM contacts c WHERE c.tenant_id=$1 AND c.id=$2 AND c.archived_at IS NULL`,
		[tenantId, contactId]
	);
	if (!result.rowCount) return context;
	const row = result.rows[0];
	const segments = await client.query(
		"SELECT id,data FROM workspace_records WHERE tenant_id=$1 AND resource='segments' AND archived_at IS NULL",
		[tenantId]
	);
	const contact = { ...row.data, ...row };
	const segmentIds = segments.rows
		.filter((segment) => segmentMatches(contact, segment.data?.rules ?? segment.data))
		.map((segment) => segment.id);
	return mergeContactContext(context, { ...row, segmentIds });
}

function localMinute(date: Date, timeZone: string) {
	const parts = new Intl.DateTimeFormat('en-US', {
		timeZone,
		hour: '2-digit',
		minute: '2-digit',
		hourCycle: 'h23'
	}).formatToParts(date);
	return (
		Number(parts.find((part) => part.type === 'hour')?.value) * 60 +
		Number(parts.find((part) => part.type === 'minute')?.value)
	);
}
export function nextAllowedWorkflowTime(
	date: Date,
	timeZone: string,
	quietHours?: WorkflowDefinition['quietHours']
) {
	if (!quietHours) return date;
	const start = Number(quietHours.start.slice(0, 2)) * 60 + Number(quietHours.start.slice(3));
	const end = Number(quietHours.end.slice(0, 2)) * 60 + Number(quietHours.end.slice(3));
	if (start === end) return date;
	let time = new Date(date);
	for (let i = 0; i < 24 * 12; i++) {
		const local = localMinute(time, timeZone);
		const quiet = start < end ? local >= start && local < end : local >= start || local < end;
		if (!quiet) return time;
		time = new Date(time.getTime() + 5 * 60_000);
	}
	return time;
}

async function withTenant<T>(
	pool: Pool,
	tenantId: string,
	userId: string | null,
	callback: (client: PoolClient) => Promise<T>
) {
	const client = await pool.connect();
	try {
		await client.query('BEGIN');
		await client.query("SELECT set_config('app.tenant_id',$1,true)", [tenantId]);
		if (userId) {
			const member = await client.query(
				"SELECT 1 FROM memberships WHERE tenant_id=$1 AND user_id=$2 AND status='active'",
				[tenantId, userId]
			);
			if (!member.rowCount)
				throw new AutomationError('Active tenant membership is unavailable.', 403);
		}
		const result = await callback(client);
		await client.query('COMMIT');
		return result;
	} catch (error) {
		await client.query('ROLLBACK').catch(() => undefined);
		throw error;
	} finally {
		client.release();
	}
}

async function activeWorkspace(session: AutomationSession, pool: Pool) {
	if (!session) throw new AutomationError('Sign in to manage workflows.', 401);
	if (session.demo)
		throw new AutomationError(
			'Live workflows require persistent storage. Demo mode never executes workflow actions.',
			503
		);
	if (!manageRoles.has(session.role))
		throw new AutomationError(
			'Only owner, admin, or fundraising manager roles may manage workflows.',
			403
		);
	const workspace = await workspaceFromPostgres(session.tenantSlug, session.userId, session.role);
	if (!workspace) throw new AutomationError('Active tenant membership is unavailable.', 403);
	return workspace;
}

function outputStatus(error: unknown) {
	return error instanceof AutomationError ? error.status : 503;
}
export { outputStatus as automationErrorStatus };

export async function listAutomations(session: AutomationSession, pool: Pool = getPool()) {
	if (!session) throw new AutomationError('Sign in to manage workflows.', 401);
	const workspace = await activeWorkspace(session, pool);
	return withTenant(pool, workspace.tenant.id, session.userId, async (client) => {
		const result = await client.query(
			`SELECT d.id,d.name,d.status,d.current_version AS "currentVersion",d.published_version AS "publishedVersion",d.created_at AS "createdAt",d.updated_at AS "updatedAt",
			v.definition AS draft,live.definition AS published
			FROM automation_definitions d LEFT JOIN automation_versions v ON v.tenant_id=d.tenant_id AND v.automation_id=d.id AND v.version=d.current_version
			LEFT JOIN automation_versions live ON live.tenant_id=d.tenant_id AND live.automation_id=d.id AND live.version=d.published_version
			WHERE d.tenant_id=$1 ORDER BY d.updated_at DESC`,
			[workspace.tenant.id]
		);
		return { automations: result.rows };
	});
}

export async function createAutomation(
	session: AutomationSession,
	input: { name: string; definition: unknown },
	pool: Pool = getPool()
) {
	if (!session) throw new AutomationError('Sign in to manage workflows.', 401);
	const workspace = await activeWorkspace(session, pool);
	const name = input.name.trim();
	if (!name || name.length > 180) issue('Workflow name must be between 1 and 180 characters.');
	const normalized = workflowSchema.parse(input.definition);
	const id = randomUUID();
	return withTenant(pool, workspace.tenant.id, session.userId, async (client) => {
		await client.query(
			"INSERT INTO automation_definitions(id,tenant_id,name,status,current_version,created_by) VALUES($1,$2,$3,'draft',1,$4)",
			[id, workspace.tenant.id, name, session.userId]
		);
		await client.query(
			'INSERT INTO automation_versions(tenant_id,automation_id,version,definition,created_by) VALUES($1,$2,1,$3,$4)',
			[workspace.tenant.id, id, normalized, session.userId]
		);
		await client.query(
			'INSERT INTO audit_log(tenant_id,actor_id,action,resource,record_id,details) VALUES($1,$2,$3,$4,$5,$6)',
			[
				workspace.tenant.id,
				session.userId,
				'automation.created',
				'automation_definitions',
				id,
				{ version: 1 }
			]
		);
		return getAutomationInTransaction(client, workspace.tenant.id, id);
	});
}

async function getAutomationInTransaction(client: PoolClient, tenantId: string, id: string) {
	const row = await client.query(
		`SELECT d.id,d.name,d.status,d.current_version AS "currentVersion",d.published_version AS "publishedVersion",d.next_schedule_at AS "nextScheduleAt",
		v.definition AS draft,live.definition AS published FROM automation_definitions d
		LEFT JOIN automation_versions v ON v.tenant_id=d.tenant_id AND v.automation_id=d.id AND v.version=d.current_version
		LEFT JOIN automation_versions live ON live.tenant_id=d.tenant_id AND live.automation_id=d.id AND live.version=d.published_version
		WHERE d.tenant_id=$1 AND d.id=$2`,
		[tenantId, id]
	);
	if (!row.rowCount) throw new AutomationError('Workflow not found in the active tenant.', 404);
	return { automation: row.rows[0] };
}

export async function getAutomation(
	session: AutomationSession,
	id: string,
	pool: Pool = getPool()
) {
	if (!session) throw new AutomationError('Sign in to manage workflows.', 401);
	const workspace = await activeWorkspace(session, pool);
	return withTenant(pool, workspace.tenant.id, session.userId, (client) =>
		getAutomationInTransaction(client, workspace.tenant.id, id)
	);
}

export async function updateAutomationDraft(
	session: AutomationSession,
	id: string,
	input: { name?: string; definition: unknown },
	pool: Pool = getPool()
) {
	if (!session) throw new AutomationError('Sign in to manage workflows.', 401);
	const workspace = await activeWorkspace(session, pool);
	const parsed = workflowSchema.parse(input.definition);
	const name = input.name?.trim();
	if (name !== undefined && (!name || name.length > 180))
		issue('Workflow name must be between 1 and 180 characters.');
	return withTenant(pool, workspace.tenant.id, session.userId, async (client) => {
		const current = await client.query(
			'SELECT name,status,current_version FROM automation_definitions WHERE tenant_id=$1 AND id=$2 FOR UPDATE',
			[workspace.tenant.id, id]
		);
		if (!current.rowCount)
			throw new AutomationError('Workflow not found in the active tenant.', 404);
		if (current.rows[0].status === 'archived')
			throw new AutomationError('Archived workflows cannot be edited.', 409);
		const version = Number(current.rows[0].current_version) + 1;
		await client.query(
			'INSERT INTO automation_versions(tenant_id,automation_id,version,definition,created_by) VALUES($1,$2,$3,$4,$5)',
			[workspace.tenant.id, id, version, parsed, session.userId]
		);
		await client.query(
			'UPDATE automation_definitions SET name=COALESCE($3,name),current_version=$4,updated_at=now() WHERE tenant_id=$1 AND id=$2',
			[workspace.tenant.id, id, name ?? null, version]
		);
		await client.query(
			'INSERT INTO audit_log(tenant_id,actor_id,action,resource,record_id,details) VALUES($1,$2,$3,$4,$5,$6)',
			[
				workspace.tenant.id,
				session.userId,
				'automation.draft_updated',
				'automation_definitions',
				id,
				{ version }
			]
		);
		return getAutomationInTransaction(client, workspace.tenant.id, id);
	});
}

export async function validateAutomation(
	session: AutomationSession,
	id: string,
	pool: Pool = getPool()
) {
	if (!session) throw new AutomationError('Sign in to manage workflows.', 401);
	const workspace = await activeWorkspace(session, pool);
	const result = await withTenant(pool, workspace.tenant.id, session.userId, (client) =>
		getAutomationInTransaction(client, workspace.tenant.id, id)
	);
	const validation = validateWorkflowDefinition(result.automation.draft);
	await withTenant(pool, workspace.tenant.id, session.userId, (client) =>
		client
			.query(
				'INSERT INTO audit_log(tenant_id,actor_id,action,resource,record_id,details) VALUES($1,$2,$3,$4,$5,$6)',
				[
					workspace.tenant.id,
					session.userId,
					'automation.validated',
					'automation_definitions',
					id,
					{ version: result.automation.currentVersion, valid: validation.valid }
				]
			)
			.then(() => undefined)
	);
	return validation;
}

export async function publishAutomation(
	session: AutomationSession,
	id: string,
	pool: Pool = getPool()
) {
	if (!session) throw new AutomationError('Sign in to manage workflows.', 401);
	const workspace = await activeWorkspace(session, pool);
	return withTenant(pool, workspace.tenant.id, session.userId, async (client) => {
		const result = await client.query(
			'SELECT d.name,d.current_version,d.status,v.definition FROM automation_definitions d JOIN automation_versions v ON v.tenant_id=d.tenant_id AND v.automation_id=d.id AND v.version=d.current_version WHERE d.tenant_id=$1 AND d.id=$2 FOR UPDATE OF d',
			[workspace.tenant.id, id]
		);
		if (!result.rowCount)
			throw new AutomationError('Workflow not found in the active tenant.', 404);
		const validation = validateWorkflowDefinition(result.rows[0].definition);
		if (!validation.valid)
			throw new AutomationError('Fix workflow validation errors before publishing.', 422);
		const version = Number(result.rows[0].current_version);
		const definition = validation.definition as WorkflowDefinition;
		const isDailyTrigger = [
			'inactivity',
			'birthday',
			'donation_anniversary',
			'pledge.overdue'
		].includes(definition.trigger.type);
		const nextSchedule =
			definition.trigger.type === 'schedule'
				? nextAllowedWorkflowTime(
						new Date(definition.trigger.startAt ?? Date.now()),
						workspace.tenant.timeZone,
						definition.quietHours
					)
				: isDailyTrigger
					? nextAllowedWorkflowTime(
							new Date(Date.now() + 60_000),
							workspace.tenant.timeZone,
							definition.quietHours
						)
					: null;
		await client.query(
			"UPDATE automation_definitions SET status='active',published_version=$3,next_schedule_at=$4,updated_at=now() WHERE tenant_id=$1 AND id=$2",
			[workspace.tenant.id, id, version, nextSchedule]
		);
		await client.query(
			'INSERT INTO audit_log(tenant_id,actor_id,action,resource,record_id,details) VALUES($1,$2,$3,$4,$5,$6)',
			[
				workspace.tenant.id,
				session.userId,
				'automation.published',
				'automation_definitions',
				id,
				{ version }
			]
		);
		return getAutomationInTransaction(client, workspace.tenant.id, id);
	});
}

export async function pauseAutomation(
	session: AutomationSession,
	id: string,
	pool: Pool = getPool()
) {
	if (!session) throw new AutomationError('Sign in to manage workflows.', 401);
	const workspace = await activeWorkspace(session, pool);
	return withTenant(pool, workspace.tenant.id, session.userId, async (client) => {
		const result = await client.query(
			"UPDATE automation_definitions SET status='paused',next_schedule_at=NULL,updated_at=now() WHERE tenant_id=$1 AND id=$2 AND status='active' RETURNING id,published_version",
			[workspace.tenant.id, id]
		);
		if (!result.rowCount)
			throw new AutomationError('Active workflow not found in the current tenant.', 404);
		await client.query(
			'INSERT INTO audit_log(tenant_id,actor_id,action,resource,record_id,details) VALUES($1,$2,$3,$4,$5,$6)',
			[
				workspace.tenant.id,
				session.userId,
				'automation.paused',
				'automation_definitions',
				id,
				{ version: result.rows[0].published_version }
			]
		);
		return { id, status: 'paused' };
	});
}

function safePreviewAction(node: Node) {
	if (node.type !== 'action') return null;
	return {
		create_task: `Would create task “${node.title || 'Stewardship follow-up'}”.`,
		notify: `Would add an internal notification “${node.title || 'Workflow notification'}”.`,
		add_tag: `Would add tag “${node.tag || ''}”.`,
		update_stage: `Would change the contact stage to “${node.stage || ''}”.`,
		update_field: `Would update a non-sensitive custom field.`,
		email: `Would queue a frozen email draft for human approval; no message would be sent.`,
		email_draft: `Would create an unsent email draft “${node.subject || node.title || 'Follow-up'}”.`,
		ai_draft: `Would request a human-reviewed AI draft; no message would be sent.`,
		webhook: `Would enqueue delivery to an explicitly approved webhook endpoint.`
	}[node.action];
}

export async function simulateAutomation(
	session: AutomationSession,
	id: string,
	contactId: string,
	pool: Pool = getPool()
) {
	if (!session) throw new AutomationError('Sign in to manage workflows.', 401);
	const workspace = await activeWorkspace(session, pool);
	if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(contactId))
		throw new AutomationError('contactId must be a UUID.', 400);
	const bundle = await withTenant(pool, workspace.tenant.id, session.userId, async (client) => {
		const workflow = await client.query(
			'SELECT v.definition FROM automation_definitions d JOIN automation_versions v ON v.tenant_id=d.tenant_id AND v.automation_id=d.id AND v.version=d.current_version WHERE d.tenant_id=$1 AND d.id=$2',
			[workspace.tenant.id, id]
		);
		const contact = await client.query(
			'SELECT id,name,email,stage,tags,data FROM contacts WHERE tenant_id=$1 AND id=$2 AND archived_at IS NULL',
			[workspace.tenant.id, contactId]
		);
		if (!workflow.rowCount)
			throw new AutomationError('Workflow not found in the active tenant.', 404);
		if (!contact.rowCount)
			throw new AutomationError('Contact not found in the active tenant.', 404);
		const context = await workflowContextForContact(client, workspace.tenant.id, contactId, {
			contact: { name: contact.rows[0].name, email: contact.rows[0].email }
		});
		return {
			definition: workflow.rows[0].definition as unknown,
			contact: contact.rows[0],
			context
		};
	});
	const validation = validateWorkflowDefinition(bundle.definition);
	if (!validation.valid) throw new AutomationError('Fix validation errors before simulation.', 422);
	const definition = validation.definition as WorkflowDefinition;
	const context: Record<string, any> = {
		...bundle.context,
		contact: {
			...(bundle.context.contact ?? {}),
			id: bundle.contact.id,
			name: bundle.contact.name,
			email: bundle.contact.email,
			stage: bundle.contact.stage,
			tags: bundle.contact.tags,
			consent: bundle.contact.data?.consent === true
		}
	};
	let next = definition.startId;
	const steps: Array<{ nodeId: string; type: string; outcome: string }> = [];
	const byId = new Map(definition.nodes.map((node) => [node.id, node]));
	while (next && steps.length < 100) {
		const node = byId.get(next);
		if (!node) break;
		steps.push({ nodeId: node.id, type: node.type, outcome: '' });
		const step = steps.at(-1)!;
		if (node.type === 'exit') {
			step.outcome = 'Simulation would exit here.';
			break;
		}
		if (node.type === 'wait') {
			step.outcome = `Would wait ${node.minutes} minute(s).`;
			next = node.next;
			continue;
		}
		if (node.type === 'condition') {
			const pass = evaluateWorkflowCondition(node, context);
			step.outcome = `Condition ${node.field} ${node.operator} ${String(node.value)} is ${pass ? 'true' : 'false'}.`;
			next = pass ? node.whenTrue : node.whenFalse;
			continue;
		}
		step.outcome = safePreviewAction(node) ?? 'Action preview unavailable.';
		next = node.next ?? '';
	}
	return {
		simulation: true,
		sideEffects: false,
		steps,
		stepLimitReached: steps.length >= 100,
		explanation:
			'Simulation evaluated the draft graph against this contact. It did not create tasks, change records, notify users, call providers, or send email.'
	};
}

async function writeOutbox(
	client: PoolClient,
	tenantId: string,
	eventType: string,
	payload: unknown,
	idempotencyKey: string
) {
	await client.query(
		'INSERT INTO outbox_events(tenant_id,event_type,payload,idempotency_key) VALUES($1,$2,$3,$4) ON CONFLICT(idempotency_key) DO NOTHING',
		[tenantId, eventType, payload, idempotencyKey]
	);
}

async function startWorkflowRun(
	client: PoolClient,
	tenantId: string,
	automationId: string,
	version: number,
	definition: WorkflowDefinition,
	triggerType: string,
	triggerKey: string,
	contactId: string | null,
	context: Record<string, unknown>,
	createdBy: string | null,
	timeZone = 'UTC',
	scheduledAt = new Date()
) {
	const dueAt = scheduledAt;
	if (contactId && definition.frequencyCapHours > 0) {
		// Different trigger events can reach this check concurrently. Serialize the
		// cap check for this workflow/contact pair so only one can pass it.
		await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
			`${tenantId}:${automationId}:${contactId}`
		]);
		const prior = await client.query(
			`SELECT 1 FROM automation_runs WHERE tenant_id=$1 AND automation_id=$2 AND contact_id=$3 AND state<>'cancelled' AND created_at>now()-($4::text||' hours')::interval LIMIT 1`,
			[tenantId, automationId, contactId, definition.frequencyCapHours]
		);
		if (prior.rowCount) {
			await client.query(
				`INSERT INTO automation_runs(tenant_id,automation_id,version,contact_id,trigger_type,trigger_key,state,context,finished_at)
				VALUES($1,$2,$3,$4,$5,$6,'cancelled',$7,now()) ON CONFLICT(tenant_id,automation_id,trigger_key) DO NOTHING`,
				[
					tenantId,
					automationId,
					version,
					contactId,
					triggerType,
					triggerKey,
					{ ...context, skipped: 'frequency_cap' }
				]
			);
			return null;
		}
	}
	const gated = nextAllowedWorkflowTime(dueAt, timeZone, definition.quietHours);
	const now = Date.now();
	const state = gated.getTime() > now ? 'waiting' : 'queued';
	const runId = randomUUID();
	const created = await client.query(
		`INSERT INTO automation_runs(tenant_id,id,automation_id,version,contact_id,trigger_type,trigger_key,state,context,next_step_id,next_at)
		VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(tenant_id,automation_id,trigger_key) DO NOTHING RETURNING id`,
		[
			tenantId,
			runId,
			automationId,
			version,
			contactId,
			triggerType,
			triggerKey,
			state,
			context,
			definition.startId,
			state === 'waiting' ? gated : null
		]
	);
	if (!created.rowCount) return null;
	if (state === 'queued')
		await writeOutbox(
			client,
			tenantId,
			'automation.step',
			{ runId, stepNumber: 1 },
			`automation:${runId}:step:1`
		);
	await client.query(
		'INSERT INTO audit_log(tenant_id,action,resource,record_id,details) VALUES($1,$2,$3,$4,$5)',
		[
			tenantId,
			'automation.run_started',
			'automation_runs',
			runId,
			{ automationId, version, triggerType, state }
		]
	);
	return runId;
}

export async function enqueueAutomationTrigger(
	event: AutomationOutboxEvent,
	pool: Pool = getPool()
) {
	const payload = event.payload as {
		resource?: unknown;
		recordId?: unknown;
		contactId?: unknown;
		idempotencyKey?: unknown;
		segmentId?: unknown;
		formId?: unknown;
		score?: unknown;
	};
	const recordId = typeof payload?.recordId === 'string' ? payload.recordId : null;
	const contactRef = typeof payload?.contactId === 'string' ? payload.contactId : null;
	if (!recordId && !contactRef) return { started: 0 };
	return withTenant(pool, event.tenantId, null, async (client) => {
		const tenant = await client.query('SELECT timezone FROM tenants WHERE id=$1', [event.tenantId]);
		const timeZone = tenant.rows[0]?.timezone ?? 'UTC';
		let triggerType: string | undefined;
		let contactId: string | null = contactRef;
		let context: Record<string, any> = {};
		const candidates: string[] = [];
		if (event.eventType === 'gift.recorded' || event.eventType === 'gifts.created') {
			const gift = await client.query(
				'SELECT id,contact_id,amount_minor,currency,kind,status,correction_of FROM gifts WHERE tenant_id=$1 AND id=$2',
				[event.tenantId, recordId]
			);
			if (!gift.rowCount || gift.rows[0].status !== 'recorded' || gift.rows[0].correction_of)
				return { started: 0 };
			triggerType = 'gift.recorded';
			candidates.push('gift.recorded');
			contactId = gift.rows[0].contact_id;
			const giftContext = {
				id: gift.rows[0].id,
				amountMinor: Number(gift.rows[0].amount_minor),
				currency: gift.rows[0].currency,
				kind: gift.rows[0].kind,
				status: gift.rows[0].status
			};
			context = { gift: giftContext };
			if (contactId) {
				const totals = await client.query(
					"SELECT count(*)::int AS count,coalesce(sum(amount_minor),0)::bigint AS total FROM gifts WHERE tenant_id=$1 AND contact_id=$2 AND status='recorded' AND kind<>'correction'",
					[event.tenantId, contactId]
				);
				context.gift.lifetimeGivingMinor = Number(totals.rows[0].total);
				if (Number(totals.rows[0].count) === 1) candidates.push('first_gift');
			}
		} else if (event.eventType === 'contacts.created') {
			const contact = await client.query(
				'SELECT id,name,stage,tags,data FROM contacts WHERE tenant_id=$1 AND id=$2 AND archived_at IS NULL',
				[event.tenantId, recordId]
			);
			if (!contact.rowCount) return { started: 0 };
			triggerType = 'contact.created';
			candidates.push('contact.created');
			contactId = contact.rows[0].id;
			context = {
				contact: {
					id: contact.rows[0].id,
					stage: contact.rows[0].stage,
					consent: contact.rows[0].data?.consent === true,
					tags: contact.rows[0].tags,
					source: contact.rows[0].data?.source ?? ''
				}
			};
		} else if (event.eventType === 'contacts.updated' || event.eventType === 'contact.tagged') {
			const contact = await client.query(
				'SELECT id,stage,tags,data FROM contacts WHERE tenant_id=$1 AND id=$2 AND archived_at IS NULL',
				[event.tenantId, recordId ?? contactRef]
			);
			if (!contact.rowCount) return { started: 0 };
			contactId = contact.rows[0].id;
			candidates.push('contact.tagged');
			context = {
				contact: {
					id: contactId,
					stage: contact.rows[0].stage,
					tags: contact.rows[0].tags,
					consent: contact.rows[0].data?.consent === true,
					source: contact.rows[0].data?.source ?? ''
				}
			};
		} else if (event.eventType === 'tasks.updated') {
			const task = await client.query(
				'SELECT id,contact_id,status FROM tasks WHERE tenant_id=$1 AND id=$2',
				[event.tenantId, recordId]
			);
			if (!task.rowCount || task.rows[0].status !== 'completed' || !task.rows[0].contact_id)
				return { started: 0 };
			triggerType = 'task.completed';
			candidates.push('task.completed');
			contactId = task.rows[0].contact_id;
			context = {
				task: { id: task.rows[0].id, status: task.rows[0].status },
				contact: { id: contactId }
			};
		} else {
			const mapped: Record<string, string> = {
				'recurring.gift.failed': 'recurring_gift_failed',
				'donation.anniversary': 'donation_anniversary',
				'segments.entered': 'segment.entry',
				'segments.exited': 'segment.exit',
				'pledges.overdue': 'pledge.overdue',
				'forms.submitted': 'form.submitted',
				'email.delivered': 'email.engagement',
				'email.opened': 'email.engagement',
				'email.clicked': 'email.engagement',
				'contacts.inactive': 'inactivity',
				'prospects.score_threshold': 'prospect.score_threshold'
			};
			const mappedType = mapped[event.eventType];
			if (!mappedType) return { started: 0 };
			triggerType = mappedType;
			candidates.push(mappedType);
			context = {
				event: {
					id: event.id ?? null,
					type: event.eventType,
					idempotencyKey: event.idempotencyKey ?? payload.idempotencyKey ?? null
				},
				contact: contactRef ? { id: contactRef } : undefined,
				record: { id: recordId }
			};
		}
		if (contactId)
			context = await workflowContextForContact(client, event.tenantId, contactId, context);
		if (event.eventType === 'prospects.score_threshold' && recordId) {
			const prospect = await client.query(
				'SELECT score,data FROM prospects WHERE tenant_id=$1 AND id=$2',
				[event.tenantId, recordId]
			);
			if (prospect.rowCount)
				context.prospect = {
					id: recordId,
					score: Number(prospect.rows[0].score ?? 0),
					data: prospect.rows[0].data
				};
		}
		if (!candidates.length) return { started: 0 };
		const workflows = await client.query(
			`SELECT d.id,d.published_version,d.created_by,v.definition FROM automation_definitions d
			JOIN automation_versions v ON v.tenant_id=d.tenant_id AND v.automation_id=d.id AND v.version=d.published_version
			WHERE d.tenant_id=$1 AND d.status='active' AND v.definition->'trigger'->>'type'=ANY($2::text[]) ORDER BY d.id`,
			[event.tenantId, candidates]
		);
		let started = 0;
		for (const workflow of workflows.rows) {
			const definition = workflowSchema.parse(workflow.definition);
			const type = definition.trigger.type;
			if (
				type === 'contact.tagged' &&
				(!contactId || !context.contact?.tags?.includes(definition.trigger.tag))
			)
				continue;
			if (
				(type === 'segment.entry' || type === 'segment.exit') &&
				payload.segmentId !== definition.trigger.segmentId
			)
				continue;
			if (type === 'form.submitted' && payload.formId !== definition.trigger.formId) continue;
			if (
				type === 'email.engagement' &&
				event.eventType !== `email.${definition.trigger.engagement}`
			)
				continue;
			if (
				type === 'prospect.score_threshold' &&
				Number(context.prospect?.score ?? payload.score ?? -1) < definition.trigger.threshold
			)
				continue;
			const eventType =
				type === 'segment.entry'
					? 'segments.entered'
					: type === 'segment.exit'
						? 'segments.exited'
						: type === 'pledge.overdue'
							? 'pledges.overdue'
							: type === 'form.submitted'
								? 'forms.submitted'
								: type === 'email.engagement'
									? event.eventType
									: type === 'recurring_gift_failed'
										? 'recurring.gift.failed'
										: type === 'donation_anniversary'
											? 'donation.anniversary'
											: type === 'inactivity'
												? 'contacts.inactive'
												: type === 'prospect.score_threshold'
													? 'prospects.score_threshold'
													: type;
			const runId = await startWorkflowRun(
				client,
				event.tenantId,
				workflow.id,
				workflow.published_version,
				definition,
				eventType,
				`${event.id ?? event.idempotencyKey ?? eventType}:${workflow.id}`,
				contactId,
				context,
				workflow.created_by,
				timeZone
			);
			if (runId) started++;
		}
		return { started };
	});
}

export async function startManualAutomation(
	session: AutomationSession,
	id: string,
	contactId: string,
	pool: Pool = getPool()
) {
	if (!session) throw new AutomationError('Sign in to manage workflows.', 401);
	const workspace = await activeWorkspace(session, pool);
	if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(contactId))
		throw new AutomationError('contactId must be a UUID.', 400);
	return withTenant(pool, workspace.tenant.id, session.userId, async (client) => {
		const workflow = await client.query(
			`SELECT d.id,d.published_version,d.created_by,v.definition FROM automation_definitions d JOIN automation_versions v ON v.tenant_id=d.tenant_id AND v.automation_id=d.id AND v.version=d.published_version WHERE d.tenant_id=$1 AND d.id=$2 AND d.status='active' FOR UPDATE OF d`,
			[workspace.tenant.id, id]
		);
		if (!workflow.rowCount) throw new AutomationError('Published active workflow not found.', 404);
		const definition = workflowSchema.parse(workflow.rows[0].definition);
		if (definition.trigger.type !== 'manual')
			throw new AutomationError('Only manual-trigger workflows can be launched here.', 422);
		const contact = await client.query(
			'SELECT id,stage,tags,data FROM contacts WHERE tenant_id=$1 AND id=$2 AND archived_at IS NULL',
			[workspace.tenant.id, contactId]
		);
		if (!contact.rowCount)
			throw new AutomationError('Contact not found in the active tenant.', 404);
		const context = {
			contact: {
				id: contactId,
				stage: contact.rows[0].stage,
				tags: contact.rows[0].tags,
				consent: contact.rows[0].data?.consent === true
			}
		};
		const runId = await startWorkflowRun(
			client,
			workspace.tenant.id,
			id,
			workflow.rows[0].published_version,
			definition,
			'manual',
			`manual:${randomUUID()}`,
			contactId,
			context,
			workflow.rows[0].created_by
		);
		return { runId, status: runId ? 'queued' : 'skipped_by_frequency_cap' };
	});
}

export async function listAutomationRuns(
	session: AutomationSession,
	id: string,
	pool: Pool = getPool()
) {
	if (!session) throw new AutomationError('Sign in to manage workflows.', 401);
	const workspace = await activeWorkspace(session, pool);
	return withTenant(pool, workspace.tenant.id, session.userId, async (client) => {
		const result = await client.query(
			`SELECT r.id,r.contact_id AS "contactId",c.name AS "contactName",r.trigger_type AS "triggerType",r.state,r.step_number AS "stepsCompleted",r.last_error AS "lastError",r.created_at AS "createdAt",r.started_at AS "startedAt",r.finished_at AS "finishedAt",count(s.id)::int AS "stepCount"
			FROM automation_runs r LEFT JOIN contacts c ON c.tenant_id=r.tenant_id AND c.id=r.contact_id LEFT JOIN automation_run_steps s ON s.tenant_id=r.tenant_id AND s.run_id=r.id
			WHERE r.tenant_id=$1 AND r.automation_id=$2 GROUP BY r.id,c.name ORDER BY r.created_at DESC LIMIT 100`,
			[workspace.tenant.id, id]
		);
		return { runs: result.rows };
	});
}

export async function getAutomationRunSteps(
	session: AutomationSession,
	runId: string,
	pool: Pool = getPool()
) {
	if (!session) throw new AutomationError('Sign in to manage workflows.', 401);
	const workspace = await activeWorkspace(session, pool);
	return withTenant(pool, workspace.tenant.id, session.userId, async (client) => {
		const run = await client.query(
			'SELECT id,state,step_number AS "stepsCompleted",next_step_id AS "nextStepId",last_error AS "lastError" FROM automation_runs WHERE tenant_id=$1 AND id=$2',
			[workspace.tenant.id, runId]
		);
		if (!run.rowCount)
			throw new AutomationError('Workflow run not found in the active tenant.', 404);
		const steps = await client.query(
			'SELECT id,step_number AS "stepNumber",node_id AS "nodeId",state,output,error,started_at AS "startedAt",finished_at AS "finishedAt" FROM automation_run_steps WHERE tenant_id=$1 AND run_id=$2 ORDER BY step_number',
			[workspace.tenant.id, runId]
		);
		return { run: run.rows[0], steps: steps.rows };
	});
}

export async function retryAutomationRun(
	session: AutomationSession,
	runId: string,
	pool: Pool = getPool()
) {
	if (!session) throw new AutomationError('Sign in to manage workflows.', 401);
	const workspace = await activeWorkspace(session, pool);
	return withTenant(pool, workspace.tenant.id, session.userId, async (client) => {
		const result = await client.query(
			"UPDATE automation_runs SET state='queued',retry_count=retry_count+1,last_error=NULL,finished_at=NULL WHERE tenant_id=$1 AND id=$2 AND state='failed' AND retry_count<20 RETURNING id,step_number,next_step_id,retry_count",
			[workspace.tenant.id, runId]
		);
		if (!result.rowCount)
			throw new AutomationError('Only a failed run can be retried; the retry limit is 20.', 409);
		const row = result.rows[0];
		const stepNumber = Number(row.step_number) + 1;
		await writeOutbox(
			client,
			workspace.tenant.id,
			'automation.step',
			{ runId: row.id, stepNumber },
			`automation:${row.id}:step:${stepNumber}:retry:${row.retry_count}`
		);
		await client.query(
			'INSERT INTO audit_log(tenant_id,actor_id,action,resource,record_id,details) VALUES($1,$2,$3,$4,$5,$6)',
			[
				workspace.tenant.id,
				session.userId,
				'automation.run_retried',
				'automation_runs',
				runId,
				{ retry: row.retry_count, stepNumber }
			]
		);
		return { runId, status: 'queued', stepNumber };
	});
}

export async function cancelAutomationRun(
	session: AutomationSession,
	runId: string,
	pool: Pool = getPool()
) {
	if (!session) throw new AutomationError('Sign in to manage workflows.', 401);
	const workspace = await activeWorkspace(session, pool);
	return withTenant(pool, workspace.tenant.id, session.userId, async (client) => {
		const result = await client.query(
			"UPDATE automation_runs SET state='cancelled',finished_at=now(),next_at=NULL WHERE tenant_id=$1 AND id=$2 AND state IN ('queued','waiting','running') RETURNING id",
			[workspace.tenant.id, runId]
		);
		if (!result.rowCount) throw new AutomationError('An active workflow run was not found.', 404);
		await client.query(
			'INSERT INTO audit_log(tenant_id,actor_id,action,resource,record_id,details) VALUES($1,$2,$3,$4,$5,$6)',
			[
				workspace.tenant.id,
				session.userId,
				'automation.run_cancelled',
				'automation_runs',
				runId,
				{}
			]
		);
		return { runId, status: 'cancelled' };
	});
}

export async function listAutomationApprovals(session: AutomationSession, pool: Pool = getPool()) {
	if (!session) throw new AutomationError('Sign in to review workflow drafts.', 401);
	const workspace = await activeWorkspace(session, pool);
	return withTenant(pool, workspace.tenant.id, session.userId, async (client) => {
		const result = await client.query(
			`SELECT a.id,a.automation_id AS "automationId",d.name AS "automationName",a.run_id AS "runId",a.step_number AS "stepNumber",a.contact_id AS "contactId",c.name AS "contactName",a.action_type AS "actionType",a.content,a.status,a.created_at AS "createdAt",a.expires_at AS "expiresAt" FROM automation_action_approvals a JOIN automation_definitions d ON d.tenant_id=a.tenant_id AND d.id=a.automation_id JOIN contacts c ON c.tenant_id=a.tenant_id AND c.id=a.contact_id WHERE a.tenant_id=$1 AND a.status='pending' AND a.expires_at>now() ORDER BY a.created_at DESC LIMIT 100`,
			[workspace.tenant.id]
		);
		return { approvals: result.rows };
	});
}

export async function generateAutomationApprovalDraft(
	session: AutomationSession,
	id: string,
	pool: Pool = getPool(),
	options: { fetcher?: typeof fetch } = {}
) {
	if (!session) throw new AutomationError('Sign in to generate workflow drafts.', 401);
	const workspace = await activeWorkspace(session, pool);
	const approval = await withTenant(pool, workspace.tenant.id, session.userId, async (client) => {
		const result = await client.query(
			`SELECT a.id,a.status,a.action_type,a.content,a.contact_id,c.name FROM automation_action_approvals a JOIN contacts c ON c.tenant_id=a.tenant_id AND c.id=a.contact_id WHERE a.tenant_id=$1 AND a.id=$2`,
			[workspace.tenant.id, id]
		);
		if (!result.rowCount) throw new AutomationError('Workflow approval request not found.', 404);
		if (result.rows[0].status !== 'pending')
			throw new AutomationError('This workflow approval is no longer pending.', 409);
		if (result.rows[0].action_type !== 'ai_draft')
			throw new AutomationError('Only AI-assisted draft requests can be generated.', 422);
		const content = result.rows[0].content as Record<string, unknown>;
		return { content, contactName: String(result.rows[0].name ?? '') };
	});
	const generated = await generateWorkflowEmailDraft(
		session,
		{
			contactName: approval.contactName,
			instructions: String(
				approval.content.prompt ??
					'Prepare a concise, respectful stewardship email body for staff review.'
			)
		},
		options
	);
	return withTenant(pool, workspace.tenant.id, session.userId, async (client) => {
		const updated = await client.query(
			`UPDATE automation_action_approvals SET content=content||$4::jsonb WHERE tenant_id=$1 AND id=$2 AND status='pending' AND content=$3::jsonb RETURNING content`,
			[
				workspace.tenant.id,
				id,
				JSON.stringify(approval.content),
				JSON.stringify({
					body: generated.body,
					aiGenerated: true,
					aiModel: generated.model,
					aiPromptHash: generated.promptHash
				})
			]
		);
		if (!updated.rowCount)
			throw new AutomationError(
				'The workflow request changed while AI generation ran. Refresh and review it again.',
				409
			);
		await client.query(
			'INSERT INTO audit_log(tenant_id,actor_id,action,resource,record_id,details) VALUES($1,$2,$3,$4,$5,$6)',
			[
				workspace.tenant.id,
				session.userId,
				'automation.draft_ai_generated',
				'automation_action_approvals',
				id,
				{ model: generated.model, promptHash: generated.promptHash }
			]
		);
		return { id, status: 'pending', generated: true, content: updated.rows[0].content };
	});
}

export async function decideAutomationApproval(
	session: AutomationSession,
	id: string,
	approved: boolean,
	pool: Pool = getPool()
) {
	if (!session) throw new AutomationError('Sign in to review workflow drafts.', 401);
	if (typeof approved !== 'boolean')
		throw new AutomationError('Choose approve or reject explicitly.', 422);
	const workspace = await activeWorkspace(session, pool);
	return withTenant(pool, workspace.tenant.id, session.userId, async (client) => {
		const found = await client.query(
			'SELECT * FROM automation_action_approvals WHERE tenant_id=$1 AND id=$2 FOR UPDATE',
			[workspace.tenant.id, id]
		);
		if (!found.rowCount) throw new AutomationError('Workflow approval request not found.', 404);
		const row = found.rows[0];
		if (row.status !== 'pending')
			throw new AutomationError('This workflow approval has already been used.', 409);
		if (new Date(row.expires_at).getTime() <= Date.now()) {
			await client.query(
				"UPDATE automation_action_approvals SET status='expired',decided_at=now() WHERE tenant_id=$1 AND id=$2",
				[workspace.tenant.id, id]
			);
			return { id, status: 'expired', draftId: null, sendStatus: 'not_sent' };
		}
		let draftId: string | null = null;
		if (approved) {
			if (
				row.action_type === 'ai_draft' &&
				(row.content as Record<string, unknown>)?.aiGenerated !== true
			)
				throw new AutomationError(
					'Generate and review the AI-assisted draft before approving it.',
					409
				);
			const contact = await client.query(
				'SELECT name,email FROM contacts WHERE tenant_id=$1 AND id=$2 AND archived_at IS NULL',
				[workspace.tenant.id, row.contact_id]
			);
			if (!contact.rowCount)
				throw new AutomationError('Contact is no longer available; no draft was created.', 409);
			const content = row.content as Record<string, unknown>;
			const draftData = {
				subject: String(content.subject ?? 'Stewardship follow-up').slice(0, 300),
				body: String(content.body ?? content.prompt ?? '').slice(0, 4000),
				htmlBody: '',
				contactId: row.contact_id,
				recipient: contact.rows[0].email ?? null,
				source: 'automation',
				status: 'draft',
				approved: false,
				workflowApprovalId: id,
				aiAssisted: row.action_type === 'ai_draft'
			};
			draftId = String(
				(
					await client.query(
						"INSERT INTO workspace_records(tenant_id,resource,data) VALUES($1,'emails',$2) RETURNING id",
						[workspace.tenant.id, draftData]
					)
				).rows[0].id
			);
		}
		await client.query(
			'UPDATE automation_action_approvals SET status=$3,decided_by=$4,decided_at=now(),draft_id=$5 WHERE tenant_id=$1 AND id=$2',
			[workspace.tenant.id, id, approved ? 'approved' : 'rejected', session.userId, draftId]
		);
		await client.query(
			'INSERT INTO audit_log(tenant_id,actor_id,action,resource,record_id,details) VALUES($1,$2,$3,$4,$5,$6)',
			[
				workspace.tenant.id,
				session.userId,
				approved ? 'automation.draft_approved' : 'automation.draft_rejected',
				'automation_action_approvals',
				id,
				{ actionType: row.action_type, contactId: row.contact_id, draftId }
			]
		);
		return { id, status: approved ? 'approved' : 'rejected', draftId, sendStatus: 'not_sent' };
	});
}

async function applyWorkflowAction(
	client: PoolClient,
	tenantId: string,
	run: Record<string, any>,
	node: Extract<Node, { type: 'action' }>,
	stepNumber: number
) {
	const contactId = run.contact_id as string | null;
	const context = run.context as Record<string, any>;
	let output: Record<string, unknown> = {};
	if (node.action === 'create_task') {
		if (!contactId) throw new Error('Create task action requires a contact.');
		const dueAt =
			node.dueInHours === undefined
				? null
				: new Date(Date.now() + node.dueInHours * 3_600_000).toISOString();
		const inserted = await client.query(
			`INSERT INTO tasks(tenant_id,title,contact_id,due_at,priority,status) VALUES($1,$2,$3,$4,'normal','open') RETURNING id,title,due_at`,
			[tenantId, node.title || 'Stewardship follow-up', contactId, dueAt]
		);
		output = {
			taskId: inserted.rows[0].id,
			title: inserted.rows[0].title,
			dueAt: inserted.rows[0].due_at
		};
		if (dueAt && node.dueInHours !== undefined && node.dueInHours > 0) {
			const key = `task-reminder:${inserted.rows[0].id}:${dueAt}`;
			await client.query(
				`INSERT INTO task_reminders(tenant_id,task_id,user_id,remind_at,idempotency_key) VALUES($1,$2,$3,$4,$5) ON CONFLICT(tenant_id,idempotency_key) DO NOTHING`,
				[tenantId, inserted.rows[0].id, run.created_by, dueAt, key]
			);
		}
	} else if (node.action === 'notify') {
		const title = node.title || 'Workflow notification';
		const key = `automation:${run.id}:notification:${stepNumber}`;
		const notify = await client.query(
			`INSERT INTO user_notifications(tenant_id,user_id,contact_id,title,body,kind,idempotency_key,data) VALUES($1,$2,$3,$4,$5,'automation',$6,$7) ON CONFLICT(tenant_id,idempotency_key) DO NOTHING RETURNING id`,
			[
				tenantId,
				run.created_by,
				contactId,
				title,
				node.body || '',
				key,
				{ automationRunId: run.id }
			]
		);
		output = { notificationId: notify.rows[0]?.id ?? null, title };
	} else if (node.action === 'add_tag') {
		if (!contactId) throw new Error('Add tag action requires a contact.');
		const tag = node.tag?.trim();
		if (!tag) throw new Error('Add tag action requires a tag.');
		await client.query(
			`UPDATE contacts SET tags=ARRAY(SELECT DISTINCT unnest(COALESCE(tags,'{}'::text[])||$3::text[])),updated_at=now() WHERE tenant_id=$1 AND id=$2`,
			[tenantId, contactId, [tag]]
		);
		output = { tag };
	} else if (node.action === 'update_stage') {
		if (!contactId || !node.stage)
			throw new Error('Update stage action requires a contact and stage.');
		await client.query(
			'UPDATE contacts SET stage=$3,updated_at=now() WHERE tenant_id=$1 AND id=$2',
			[tenantId, contactId, node.stage]
		);
		output = { stage: node.stage };
	} else if (node.action === 'update_field') {
		if (!contactId || !node.fieldId)
			throw new Error('Custom field action requires a contact and field.');
		const field = await client.query(
			'SELECT kind,sensitive FROM custom_field_definitions WHERE tenant_id=$1 AND id=$2',
			[tenantId, node.fieldId]
		);
		if (!field.rowCount || field.rows[0].sensitive)
			throw new Error('Workflow field updates require an existing non-sensitive field.');
		const value = node.value;
		const kind = field.rows[0].kind;
		const valid =
			kind === 'number'
				? typeof value === 'number' && Number.isFinite(value)
				: kind === 'boolean'
					? typeof value === 'boolean'
					: kind === 'date'
						? typeof value === 'string' && /^\\d{4}-\\d{2}-\\d{2}$/.test(value)
						: kind === 'choice' || kind === 'text'
							? typeof value === 'string'
							: false;
		if (!valid) throw new Error('Workflow field value does not match the selected custom field.');
		await client.query(
			'INSERT INTO custom_field_values(tenant_id,contact_id,field_id,value) VALUES($1,$2,$3,$4) ON CONFLICT(tenant_id,contact_id,field_id) DO UPDATE SET value=EXCLUDED.value,updated_at=now()',
			[tenantId, contactId, node.fieldId, JSON.stringify(value)]
		);
		output = { fieldId: node.fieldId, updated: true };
	} else if (node.action === 'webhook') {
		if (!node.endpointId) throw new Error('Webhook actions require an already-approved endpoint.');
		const endpoint = await client.query(
			'SELECT id FROM webhook_endpoints WHERE tenant_id=$1 AND id=$2 AND enabled=true AND revoked_at IS NULL AND approved_at IS NOT NULL AND $3=ANY(events)',
			[tenantId, node.endpointId, 'automation.action']
		);
		if (!endpoint.rowCount)
			throw new Error('Choose an active endpoint explicitly approved for workflow actions.');
		await writeOutbox(
			client,
			tenantId,
			'automation.action',
			{
				resource: 'automation_runs',
				recordId: run.id,
				contactId,
				endpointId: node.endpointId,
				actionName: node.eventName || 'workflow.action'
			},
			`automation:${run.id}:webhook:${stepNumber}`
		);
		output = { endpointId: node.endpointId, queued: true };
	} else if (node.action === 'email' || node.action === 'ai_draft') {
		if (!contactId) throw new Error('Draft actions require a contact.');
		const content = {
			subject:
				node.subject ||
				node.title ||
				(node.action === 'ai_draft' ? 'AI-assisted stewardship draft' : 'Stewardship follow-up'),
			body: node.body || '',
			contactId,
			aiAssisted: node.action === 'ai_draft',
			prompt:
				node.action === 'ai_draft'
					? node.body || 'Prepare a concise, respectful stewardship draft for staff review.'
					: undefined
		};
		const approval = await client.query(
			`INSERT INTO automation_action_approvals(tenant_id,automation_id,run_id,step_number,contact_id,action_type,content,requested_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(tenant_id,run_id,step_number) DO NOTHING RETURNING id`,
			[
				tenantId,
				run.automation_id,
				run.id,
				stepNumber,
				contactId,
				node.action,
				content,
				run.created_by
			]
		);
		output = {
			approvalId: approval.rows[0]?.id ?? null,
			status: 'awaiting_human_approval',
			sent: false
		};
	} else {
		// Legacy email_draft remains explicitly unsent and unapproved.
		if (!contactId) throw new Error('Email draft action requires a contact.');
		const contact = await client.query(
			'SELECT name,email FROM contacts WHERE tenant_id=$1 AND id=$2',
			[tenantId, contactId]
		);
		const data = {
			subject: node.subject || node.title || 'Follow-up',
			body: node.body || '',
			recipient: contact.rows[0]?.email ?? null,
			contactId,
			source: 'automation',
			status: 'draft',
			approved: false
		};
		const draft = await client.query(
			`INSERT INTO workspace_records(tenant_id,resource,id,data) VALUES($1,'emails',gen_random_uuid(),$2) RETURNING id`,
			[tenantId, data]
		);
		output = { emailDraftId: draft.rows[0].id, status: 'draft', sent: false };
	}
	return output;
}

export async function handleAutomationStepOutboxEvent(
	event: AutomationOutboxEvent,
	pool: Pool = getPool()
) {
	const payload = event.payload as { runId?: unknown; stepNumber?: unknown };
	if (
		typeof payload?.runId !== 'string' ||
		typeof payload.stepNumber !== 'number' ||
		!Number.isInteger(payload.stepNumber) ||
		payload.stepNumber < 1
	)
		return;
	return withTenant(pool, event.tenantId, null, async (client) => {
		const found = await client.query(
			`SELECT r.*,d.created_by,v.definition FROM automation_runs r JOIN automation_definitions d ON d.tenant_id=r.tenant_id AND d.id=r.automation_id JOIN automation_versions v ON v.tenant_id=r.tenant_id AND v.automation_id=r.automation_id AND v.version=r.version WHERE r.tenant_id=$1 AND r.id=$2 FOR UPDATE OF r`,
			[event.tenantId, payload.runId]
		);
		if (!found.rowCount) return;
		const run = found.rows[0];
		const stepNumber = payload.stepNumber as number;
		if (
			run.state === 'cancelled' ||
			run.state === 'completed' ||
			run.state === 'failed' ||
			Number(run.step_number) >= stepNumber
		)
			return;
		if (Number(run.step_number) + 1 !== stepNumber || !['queued', 'running'].includes(run.state))
			return;
		const definition = workflowSchema.parse(run.definition);
		const node = definition.nodes.find((item) => item.id === run.next_step_id);
		if (!node) {
			await client.query(
				"UPDATE automation_runs SET state='failed',last_error='Workflow node is missing.',finished_at=now() WHERE tenant_id=$1 AND id=$2",
				[event.tenantId, run.id]
			);
			return;
		}
		await client.query(
			"UPDATE automation_runs SET state='running',started_at=COALESCE(started_at,now()) WHERE tenant_id=$1 AND id=$2",
			[event.tenantId, run.id]
		);
		let output: Record<string, unknown> = {};
		let next: string | null = null;
		let waitUntil: Date | null = null;
		if (node.type === 'exit') {
			output = { completed: true };
		} else if (node.type === 'wait') {
			output = { waitMinutes: node.minutes };
			next = node.next;
			waitUntil = new Date(Date.now() + node.minutes * 60_000);
		} else if (node.type === 'condition') {
			const passes = evaluateWorkflowCondition(node, run.context ?? {});
			output = { condition: node.field, passed: passes };
			next = passes ? node.whenTrue : node.whenFalse;
		} else if (node.type === 'action') {
			output = await applyWorkflowAction(client, event.tenantId, run, node, stepNumber);
			next = node.next ?? null;
		}
		await client.query(
			`INSERT INTO automation_run_steps(tenant_id,run_id,step_number,node_id,state,input,output,finished_at) VALUES($1,$2,$3,$4,'completed',$5,$6,now()) ON CONFLICT(tenant_id,run_id,step_number) DO NOTHING`,
			[event.tenantId, run.id, stepNumber, node.id, { type: node.type }, output]
		);
		if (waitUntil) {
			await client.query(
				"UPDATE automation_runs SET state='waiting',step_number=$3,next_step_id=$4,next_at=$5 WHERE tenant_id=$1 AND id=$2",
				[event.tenantId, run.id, stepNumber, next, waitUntil]
			);
			return;
		}
		if (!next) {
			await client.query(
				"UPDATE automation_runs SET state='completed',step_number=$3,next_step_id=NULL,next_at=NULL,finished_at=now(),last_error=NULL WHERE tenant_id=$1 AND id=$2",
				[event.tenantId, run.id, stepNumber]
			);
			return;
		}
		await client.query(
			"UPDATE automation_runs SET state='queued',step_number=$3,next_step_id=$4,next_at=NULL WHERE tenant_id=$1 AND id=$2",
			[event.tenantId, run.id, stepNumber, next]
		);
		await writeOutbox(
			client,
			event.tenantId,
			'automation.step',
			{ runId: run.id, stepNumber: stepNumber + 1 },
			`automation:${run.id}:step:${stepNumber + 1}`
		);
	});
}

export async function markAutomationRunFailed(
	event: AutomationOutboxEvent,
	error: unknown,
	pool: Pool = getPool()
) {
	const payload = event.payload as { runId?: unknown; stepNumber?: unknown };
	if (typeof payload?.runId !== 'string') return;
	const message = (error instanceof Error ? error.message : 'Workflow action failed')
		.replace(/\s+/g, ' ')
		.slice(0, 1000);
	return withTenant(pool, event.tenantId, null, async (client) => {
		const result = await client.query(
			"UPDATE automation_runs SET state='failed',last_error=$3,finished_at=now(),next_at=NULL WHERE tenant_id=$1 AND id=$2 AND state IN ('queued','running') RETURNING id,next_step_id",
			[event.tenantId, payload.runId, message]
		);
		if (!result.rowCount) return;
		const number =
			Number(payload.stepNumber) ||
			Number(
				(
					await client.query(
						'SELECT step_number FROM automation_runs WHERE tenant_id=$1 AND id=$2',
						[event.tenantId, payload.runId]
					)
				).rows[0]?.step_number
			) + 1;
		await client.query(
			`INSERT INTO automation_run_steps(tenant_id,run_id,step_number,node_id,state,error,finished_at) VALUES($1,$2,$3,$4,'failed',$5,now()) ON CONFLICT(tenant_id,run_id,step_number) DO UPDATE SET state='failed',error=EXCLUDED.error,finished_at=now()`,
			[event.tenantId, payload.runId, number, result.rows[0].next_step_id ?? 'unknown', message]
		);
	});
}

export async function dispatchDueTenantWork(pool: Pool, tenantId: string) {
	return withTenant(pool, tenantId, null, async (client) => {
		const tenant = await client.query('SELECT timezone FROM tenants WHERE id=$1', [tenantId]);
		const timeZone = tenant.rows[0]?.timezone ?? 'UTC';
		const now = new Date();
		let scheduled = 0;
		const workflows = await client.query(
			`SELECT d.id,d.published_version,d.created_by,d.next_schedule_at,v.definition FROM automation_definitions d JOIN automation_versions v ON v.tenant_id=d.tenant_id AND v.automation_id=d.id AND v.version=d.published_version WHERE d.tenant_id=$1 AND d.status='active' AND d.next_schedule_at<=now() ORDER BY d.id FOR NO KEY UPDATE OF d SKIP LOCKED`,
			[tenantId]
		);
		for (const row of workflows.rows) {
			const definition = workflowSchema.parse(row.definition);
			const trigger = definition.trigger;
			const due = new Date(row.next_schedule_at);
			if (trigger.type === 'schedule') {
				const runId = await startWorkflowRun(
					client,
					tenantId,
					row.id,
					row.published_version,
					definition,
					'schedule',
					`schedule:${row.id}:${due.toISOString()}`,
					null,
					{ scheduledAt: due.toISOString() },
					row.created_by,
					timeZone,
					due
				);
				let next = new Date(due.getTime() + trigger.intervalMinutes * 60_000);
				while (next <= now) next = new Date(next.getTime() + trigger.intervalMinutes * 60_000);
				const allowed = nextAllowedWorkflowTime(next, timeZone, definition.quietHours);
				await client.query(
					'UPDATE automation_definitions SET next_schedule_at=$3 WHERE tenant_id=$1 AND id=$2',
					[tenantId, row.id, allowed]
				);
				if (runId) scheduled++;
				continue;
			}
			let candidates: { id: string; context: Record<string, unknown> }[] = [];
			if (trigger.type === 'inactivity') {
				const rows = await client.query(
					`SELECT c.id FROM contacts c WHERE c.tenant_id=$1 AND c.archived_at IS NULL AND NOT EXISTS (SELECT 1 FROM gifts g WHERE g.tenant_id=c.tenant_id AND g.contact_id=c.id AND g.status='recorded' AND g.kind<>'correction' AND g.occurred_at>now()-($2::text||' days')::interval) ORDER BY c.id LIMIT 500`,
					[tenantId, trigger.days]
				);
				candidates = rows.rows.map((item) => ({
					id: item.id,
					context: { event: { type: 'inactivity', days: trigger.days } }
				}));
			} else if (trigger.type === 'donation_anniversary') {
				const rows = await client.query(
					`SELECT g.contact_id AS id FROM gifts g WHERE g.tenant_id=$1 AND g.contact_id IS NOT NULL AND g.status='recorded' AND g.kind<>'correction' GROUP BY g.contact_id HAVING to_char(min(g.occurred_at) AT TIME ZONE $2,'MM-DD')=to_char(now() AT TIME ZONE $2,'MM-DD') ORDER BY g.contact_id LIMIT 500`,
					[tenantId, timeZone]
				);
				candidates = rows.rows.map((item) => ({
					id: item.id,
					context: { event: { type: 'donation_anniversary' } }
				}));
			} else if (trigger.type === 'birthday') {
				const field = await client.query(
					'SELECT kind,sensitive FROM custom_field_definitions WHERE tenant_id=$1 AND id=$2',
					[tenantId, trigger.fieldId]
				);
				if (field.rowCount && field.rows[0].kind === 'date' && !field.rows[0].sensitive) {
					const rows = await client.query(
						`SELECT c.id FROM contacts c JOIN custom_field_values v ON v.tenant_id=c.tenant_id AND v.contact_id=c.id AND v.field_id=$2 WHERE c.tenant_id=$1 AND c.archived_at IS NULL AND c.data->>'consent'='true' AND EXISTS(SELECT 1 FROM consents co WHERE co.tenant_id=c.tenant_id AND co.contact_id=c.id AND co.channel='email' AND co.purpose='marketing' AND co.status='granted') AND v.value#>>'{}' ~ '^\\d{4}-\\d{2}-\\d{2}$' AND to_char((v.value#>>'{}')::date,'MM-DD')=to_char(now() AT TIME ZONE $3,'MM-DD') ORDER BY c.id LIMIT 500`,
						[tenantId, trigger.fieldId, timeZone]
					);
					candidates = rows.rows.map((item) => ({
						id: item.id,
						context: { event: { type: 'birthday', consented: true } }
					}));
				}
			} else if (trigger.type === 'pledge.overdue') {
				const rows = await client.query(
					`SELECT DISTINCT p.contact_id AS id FROM pledge_installments i JOIN pledges p ON p.tenant_id=i.tenant_id AND p.id=i.pledge_id WHERE i.tenant_id=$1 AND i.gift_id IS NULL AND p.status='active' AND i.due_at<=now()-($2::text||' days')::interval ORDER BY p.contact_id LIMIT 500`,
					[tenantId, trigger.daysOverdue]
				);
				candidates = rows.rows.map((item) => ({
					id: item.id,
					context: { event: { type: 'pledge.overdue', daysOverdue: trigger.daysOverdue } }
				}));
			}
			const dateKey = new Intl.DateTimeFormat('en-CA', {
				timeZone,
				year: 'numeric',
				month: '2-digit',
				day: '2-digit'
			}).format(due);
			for (const candidate of candidates) {
				const context = await workflowContextForContact(
					client,
					tenantId,
					candidate.id,
					candidate.context
				);
				const runId = await startWorkflowRun(
					client,
					tenantId,
					row.id,
					row.published_version,
					definition,
					trigger.type,
					`daily:${row.id}:${dateKey}:${candidate.id}`,
					candidate.id,
					context,
					row.created_by,
					timeZone,
					due
				);
				if (runId) scheduled++;
			}
			const next = nextAllowedWorkflowTime(
				new Date(due.getTime() + 24 * 60 * 60_000),
				timeZone,
				definition.quietHours
			);
			await client.query(
				'UPDATE automation_definitions SET next_schedule_at=$3 WHERE tenant_id=$1 AND id=$2',
				[tenantId, row.id, next]
			);
		}
		const waiting = await client.query(
			`SELECT id,step_number FROM automation_runs WHERE tenant_id=$1 AND state='waiting' AND next_at<=now() ORDER BY next_at LIMIT 100 FOR UPDATE SKIP LOCKED`,
			[tenantId]
		);
		for (const run of waiting.rows) {
			const stepNumber = Number(run.step_number) + 1;
			await client.query(
				"UPDATE automation_runs SET state='queued',next_at=NULL WHERE tenant_id=$1 AND id=$2 AND state='waiting'",
				[tenantId, run.id]
			);
			await writeOutbox(
				client,
				tenantId,
				'automation.step',
				{ runId: run.id, stepNumber },
				`automation:${run.id}:step:${stepNumber}`
			);
		}
		const reminders = await client.query(
			`SELECT r.id,r.task_id,r.user_id,r.idempotency_key,t.title,t.contact_id FROM task_reminders r JOIN tasks t ON t.tenant_id=r.tenant_id AND t.id=r.task_id WHERE r.tenant_id=$1 AND r.state='scheduled' AND r.remind_at<=now() AND t.status NOT IN ('completed','cancelled') ORDER BY r.remind_at LIMIT 100 FOR UPDATE OF r SKIP LOCKED`,
			[tenantId]
		);
		for (const reminder of reminders.rows) {
			await client.query("UPDATE task_reminders SET state='queued' WHERE tenant_id=$1 AND id=$2", [
				tenantId,
				reminder.id
			]);
			await writeOutbox(
				client,
				tenantId,
				'task.reminder',
				{ reminderId: reminder.id },
				reminder.idempotency_key
			);
		}
		return { scheduled, waiting: waiting.rowCount, reminders: reminders.rowCount };
	});
}

export async function handleTaskReminderOutboxEvent(
	event: AutomationOutboxEvent,
	pool: Pool = getPool()
) {
	const payload = event.payload as { reminderId?: unknown };
	if (typeof payload?.reminderId !== 'string') return;
	return withTenant(pool, event.tenantId, null, async (client) => {
		const reminder = await client.query(
			`SELECT r.id,r.task_id,r.user_id,r.state,r.idempotency_key,t.title,t.contact_id FROM task_reminders r JOIN tasks t ON t.tenant_id=r.tenant_id AND t.id=r.task_id WHERE r.tenant_id=$1 AND r.id=$2 FOR UPDATE OF r`,
			[event.tenantId, payload.reminderId]
		);
		if (!reminder.rowCount || reminder.rows[0].state !== 'queued') return;
		const row = reminder.rows[0];
		await client.query(
			`INSERT INTO user_notifications(tenant_id,user_id,task_id,contact_id,title,body,kind,idempotency_key,data) VALUES($1,$2,$3,$4,$5,$6,'task_reminder',$7,$8) ON CONFLICT(tenant_id,idempotency_key) DO NOTHING`,
			[
				event.tenantId,
				row.user_id,
				row.task_id,
				row.contact_id,
				`Task due: ${row.title}`,
				'A scheduled reminder is due.',
				row.idempotency_key,
				{ reminderId: row.id }
			]
		);
		await client.query(
			"UPDATE task_reminders SET state='delivered',delivered_at=now() WHERE tenant_id=$1 AND id=$2",
			[event.tenantId, row.id]
		);
	});
}

export async function noopKnownDomainEvent(event: AutomationOutboxEvent, pool: Pool = getPool()) {
	return withTenant(pool, event.tenantId, null, async (client) => {
		await client.query(
			'INSERT INTO audit_log(tenant_id,action,resource,record_id,details) VALUES($1,$2,$3,$4,$5)',
			[
				event.tenantId,
				'domain_event.observed',
				'outbox_events',
				event.id ?? null,
				{ eventType: event.eventType, idempotencyKey: event.idempotencyKey ?? null }
			]
		);
	});
}
