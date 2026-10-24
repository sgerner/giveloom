import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { getPool, workspaceFromPostgres } from './database';
import type { AutomationSession } from './automation';
import { AutomationError } from './automation';
import { demoAuthorization } from './tenant-service';
import { demoRead, demoWrite } from './demo-extensions';

async function withTenant<T>(
	pool: Pool,
	tenantId: string,
	userId: string,
	fn: (client: PoolClient) => Promise<T>
) {
	const client = await pool.connect();
	try {
		await client.query('BEGIN');
		await client.query("SELECT set_config('app.tenant_id',$1,true)", [tenantId]);
		const membership = await client.query(
			"SELECT 1 FROM memberships WHERE tenant_id=$1 AND user_id=$2 AND status='active'",
			[tenantId, userId]
		);
		if (!membership.rowCount)
			throw new AutomationError('Active tenant membership is unavailable.', 403);
		const result = await fn(client);
		await client.query('COMMIT');
		return result;
	} catch (error) {
		await client.query('ROLLBACK').catch(() => undefined);
		throw error;
	} finally {
		client.release();
	}
}
async function access(session: AutomationSession, pool?: Pool) {
	if (!session) throw new AutomationError('Sign in to access stewardship tools.', 401);
	if (session.demo) return demoAuthorization(session);
	const workspace = await workspaceFromPostgres(session.tenantSlug, session.userId, session.role);
	if (!workspace) throw new AutomationError('Active tenant membership is unavailable.', 403);
	return workspace;
}
function checkText(value: unknown, name: string, max: number, required = false) {
	if (typeof value !== 'string' || (required && !value.trim()) || value.length > max)
		throw new AutomationError(
			`${name} must be ${required ? 'present and ' : ''}no more than ${max} characters.`,
			422
		);
	return value.trim();
}
function dateValue(value: unknown, name: string, required = false) {
	if (value === null || value === undefined || value === '') {
		if (required) throw new AutomationError(`${name} is required.`, 422);
		return null;
	}
	const date = new Date(String(value));
	if (!Number.isFinite(date.getTime()))
		throw new AutomationError(`${name} must be a valid date.`, 422);
	return date.toISOString();
}
const priorities = new Set(['low', 'normal', 'high', 'urgent']);
const taskStatuses = new Set(['open', 'in_progress', 'completed', 'cancelled']);
const stepKinds = new Set([
	'call',
	'meeting',
	'email_draft',
	'proposal',
	'research',
	'note',
	'other'
]);
const planStatuses = new Set(['active', 'completed', 'cancelled']);
const proposalStages = new Set([
	'discovery',
	'drafting',
	'submitted',
	'negotiation',
	'won',
	'lost'
]);

export async function listTasks(
	session: AutomationSession,
	filters: { contactId?: string; from?: string; to?: string } = {},
	pool?: Pool
) {
	if (!session) throw new AutomationError('Sign in to access stewardship tools.', 401);
	const workspace = await access(session, pool);
	if (session.demo) {
		const extension = await demoRead(session, 'tasks');
		const byId = new Map<string, any>();
		for (const row of [...workspace.tasks, ...extension]) byId.set(String(row.id), row);
		const tasks = [...byId.values()]
			.filter((row) => !filters.contactId || row.contactId === filters.contactId)
			.filter((row) => !filters.from || Boolean(row.dueAt && String(row.dueAt) >= filters.from!))
			.filter((row) => !filters.to || Boolean(row.dueAt && String(row.dueAt) <= filters.to!))
			.map((row) => ({
				...row,
				contactName: workspace.contacts.find((contact) => contact.id === row.contactId)?.name
					? String(workspace.contacts.find((contact) => contact.id === row.contactId)?.name)
					: null
			}))
			.sort((a, b) => String(a.dueAt ?? '').localeCompare(String(b.dueAt ?? '')));
		return { tasks };
	}
	return withTenant(pool ?? getPool(), workspace.tenant.id, session.userId, async (client) => {
		const result = await client.query(
			`SELECT t.id,t.title,t.contact_id AS "contactId",c.name AS "contactName",t.due_at AS "dueAt",t.priority,t.status,t.assigned_to AS "assignedTo",t.recurrence,t.created_at AS "createdAt" FROM tasks t LEFT JOIN contacts c ON c.tenant_id=t.tenant_id AND c.id=t.contact_id WHERE t.tenant_id=$1 AND ($2::uuid IS NULL OR t.contact_id=$2) AND ($3::timestamptz IS NULL OR t.due_at >= $3) AND ($4::timestamptz IS NULL OR t.due_at <= $4) ORDER BY t.due_at NULLS LAST,t.created_at DESC LIMIT 500`,
			[
				workspace.tenant.id,
				filters.contactId ?? null,
				filters.from ? dateValue(filters.from, 'from') : null,
				filters.to ? dateValue(filters.to, 'to') : null
			]
		);
		return { tasks: result.rows };
	});
}
export async function listTaskAssignees(session: AutomationSession, pool?: Pool) {
	if (!session) throw new AutomationError('Sign in to access stewardship tools.', 401);
	const workspace = await access(session, pool);
	if (session.demo) return { assignees: [] };
	return withTenant(pool ?? getPool(), workspace.tenant.id, session.userId, async (client) => {
		const result = await client.query(
			`SELECT u.id,u.display_name AS name,m.role FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.tenant_id=$1 AND m.status='active' AND u.disabled_at IS NULL ORDER BY u.display_name`,
			[workspace.tenant.id]
		);
		return { assignees: result.rows };
	});
}
export async function createTask(
	session: AutomationSession,
	input: Record<string, unknown>,
	pool?: Pool
) {
	if (!session) throw new AutomationError('Sign in to access stewardship tools.', 401);
	const workspace = await access(session, pool);
	const title = checkText(input.title, 'title', 180, true);
	const contactId = input.contactId ? String(input.contactId) : null;
	const dueAt = dateValue(input.dueAt, 'dueAt');
	const priority = String(input.priority ?? 'normal');
	if (!priorities.has(priority)) throw new AutomationError('priority is invalid.', 422);
	const assignedTo = input.assignedTo ? String(input.assignedTo) : session.userId;
	const recurrence = input.recurrence ?? {};
	if (typeof recurrence !== 'object' || recurrence === null || Array.isArray(recurrence))
		throw new AutomationError('recurrence must be an object.', 422);
	const rec = recurrence as Record<string, unknown>;
	if (
		rec.frequency !== undefined &&
		!['daily', 'weekly', 'monthly'].includes(String(rec.frequency))
	)
		throw new AutomationError('recurrence.frequency must be daily, weekly, or monthly.', 422);
	if (
		rec.interval !== undefined &&
		(!Number.isInteger(rec.interval) || Number(rec.interval) < 1 || Number(rec.interval) > 365)
	)
		throw new AutomationError('recurrence.interval must be an integer from 1 to 365.', 422);
	if (
		rec.until !== undefined &&
		rec.until !== null &&
		!Number.isFinite(new Date(String(rec.until)).getTime())
	)
		throw new AutomationError('recurrence.until must be a valid date.', 422);
	if (session.demo) {
		if (contactId && !workspace.contacts.some((contact) => contact.id === contactId))
			throw new AutomationError('Contact is not in the active tenant.', 404);
		if (input.assignedTo && String(input.assignedTo) !== session.userId)
			throw new AutomationError('Demo tasks can only be assigned to the current demo user.', 422);
		return demoWrite(
			session,
			['owner', 'admin', 'fundraising_manager', 'fundraiser'],
			(records) => {
				const rows = (records.tasks ??= []);
				const task = {
					id: randomUUID(),
					title,
					contactId,
					dueAt,
					priority,
					status: 'open',
					assignedTo,
					recurrence,
					createdAt: new Date().toISOString()
				};
				rows.push(task);
				return { task };
			}
		);
	}
	return withTenant(pool ?? getPool(), workspace.tenant.id, session.userId, async (client) => {
		if (contactId) {
			const c = await client.query(
				'SELECT 1 FROM contacts WHERE tenant_id=$1 AND id=$2 AND archived_at IS NULL',
				[workspace.tenant.id, contactId]
			);
			if (!c.rowCount) throw new AutomationError('Contact is not in the active tenant.', 404);
		}
		const assigned = await client.query(
			"SELECT 1 FROM memberships WHERE tenant_id=$1 AND user_id=$2 AND status='active'",
			[workspace.tenant.id, assignedTo]
		);
		if (!assigned.rowCount)
			throw new AutomationError('Assignee is not an active tenant member.', 422);
		const task = await client.query(
			`INSERT INTO tasks(tenant_id,title,contact_id,due_at,priority,status,assigned_to,recurrence) VALUES($1,$2,$3,$4,$5,'open',$6,$7) RETURNING id,title,contact_id AS "contactId",due_at AS "dueAt",priority,status,assigned_to AS "assignedTo",recurrence`,
			[workspace.tenant.id, title, contactId, dueAt, priority, assignedTo, recurrence]
		);
		await client.query(
			'INSERT INTO audit_log(tenant_id,actor_id,action,resource,record_id,details) VALUES($1,$2,$3,$4,$5,$6)',
			[
				workspace.tenant.id,
				session.userId,
				'task.created',
				'tasks',
				task.rows[0].id,
				{ contactId, dueAt }
			]
		);
		if (dueAt)
			await scheduleTaskReminder(client, workspace.tenant.id, task.rows[0].id, assignedTo, dueAt);
		return { task: task.rows[0] };
	});
}
async function scheduleTaskReminder(
	client: PoolClient,
	tenantId: string,
	taskId: string,
	userId: string,
	dueAt: string
) {
	const key = `task-reminder:${taskId}:${dueAt}`;
	await client.query(
		`INSERT INTO task_reminders(tenant_id,task_id,user_id,remind_at,idempotency_key) VALUES($1,$2,$3,$4,$5) ON CONFLICT(tenant_id,idempotency_key) DO NOTHING`,
		[tenantId, taskId, userId, dueAt, key]
	);
}
export async function updateTask(
	session: AutomationSession,
	id: string,
	input: Record<string, unknown>,
	pool?: Pool
) {
	if (!session) throw new AutomationError('Sign in to access stewardship tools.', 401);
	const workspace = await access(session, pool);
	if (session.demo) {
		const existing = (await listTasks(session, {}, pool)).tasks.find((task) => task.id === id);
		if (!existing) throw new AutomationError('Task not found in the active tenant.', 404);
		const title =
			input.title === undefined
				? String(existing.title)
				: checkText(input.title, 'title', 180, true);
		const status = String(input.status ?? existing.status);
		if (!taskStatuses.has(status)) throw new AutomationError('Task status is invalid.', 422);
		const priority = String(input.priority ?? existing.priority);
		if (!priorities.has(priority)) throw new AutomationError('Task priority is invalid.', 422);
		const dueAt = input.dueAt === undefined ? existing.dueAt : dateValue(input.dueAt, 'dueAt');
		if (input.assignedTo && String(input.assignedTo) !== session.userId)
			throw new AutomationError('Demo tasks can only be assigned to the current demo user.', 422);
		return demoWrite(
			session,
			['owner', 'admin', 'fundraising_manager', 'fundraiser'],
			(records) => {
				records.tasks ??= [];
				const row = records.tasks.find((task) => task.id === id);
				if (row)
					Object.assign(row, {
						title,
						status,
						priority,
						dueAt,
						assignedTo: session.userId,
						updatedAt: new Date().toISOString()
					});
				else
					records.tasks.push({
						...existing,
						title,
						status,
						priority,
						dueAt,
						assignedTo: session.userId,
						updatedAt: new Date().toISOString()
					});
				return { task: records.tasks.find((task) => task.id === id) };
			}
		);
	}
	return withTenant(pool ?? getPool(), workspace.tenant.id, session.userId, async (client) => {
		const current = await client.query(
			'SELECT * FROM tasks WHERE tenant_id=$1 AND id=$2 FOR UPDATE',
			[workspace.tenant.id, id]
		);
		if (!current.rowCount) throw new AutomationError('Task not found in the active tenant.', 404);
		const row = current.rows[0];
		const title =
			input.title === undefined ? row.title : checkText(input.title, 'title', 180, true);
		const status = String(input.status ?? row.status);
		if (!taskStatuses.has(status)) throw new AutomationError('Task status is invalid.', 422);
		const priority = String(input.priority ?? row.priority);
		if (!priorities.has(priority)) throw new AutomationError('Task priority is invalid.', 422);
		const dueAt = input.dueAt === undefined ? row.due_at : dateValue(input.dueAt, 'dueAt');
		const assignedTo = input.assignedTo === undefined ? row.assigned_to : String(input.assignedTo);
		if (assignedTo) {
			const m = await client.query(
				"SELECT 1 FROM memberships WHERE tenant_id=$1 AND user_id=$2 AND status='active'",
				[workspace.tenant.id, assignedTo]
			);
			if (!m.rowCount) throw new AutomationError('Assignee is not an active tenant member.', 422);
		}
		const updated = await client.query(
			`UPDATE tasks SET title=$3,status=$4,priority=$5,due_at=$6,assigned_to=$7,updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING id,title,contact_id AS "contactId",due_at AS "dueAt",priority,status,assigned_to AS "assignedTo",recurrence`,
			[workspace.tenant.id, id, title, status, priority, dueAt, assignedTo]
		);
		if (dueAt && status !== 'completed' && status !== 'cancelled')
			await scheduleTaskReminder(client, workspace.tenant.id, id, assignedTo, dueAt);
		if (status === 'completed' && row.status !== 'completed') {
			await client.query(
				'INSERT INTO outbox_events(tenant_id,event_type,payload,idempotency_key) VALUES($1,$2,$3,$4) ON CONFLICT(idempotency_key) DO NOTHING',
				[
					workspace.tenant.id,
					'tasks.updated',
					{ resource: 'tasks', recordId: id },
					`tasks:${id}:completed:${Date.now()}`
				]
			);
			await createNextRecurringTask(client, workspace.tenant.id, row);
		}
		await client.query(
			'INSERT INTO audit_log(tenant_id,actor_id,action,resource,record_id,details) VALUES($1,$2,$3,$4,$5,$6)',
			[workspace.tenant.id, session.userId, 'task.updated', 'tasks', id, { status, priority }]
		);
		return { task: updated.rows[0] };
	});
}
async function createNextRecurringTask(
	client: PoolClient,
	tenantId: string,
	row: Record<string, any>
) {
	const recurrence = row.recurrence;
	if (
		!recurrence ||
		!['daily', 'weekly', 'monthly'].includes(recurrence.frequency) ||
		!row.due_at ||
		row.status === 'cancelled'
	)
		return;
	const interval = Math.max(1, Math.min(365, Number(recurrence.interval ?? 1)));
	const next = new Date(row.due_at);
	if (recurrence.frequency === 'daily') next.setUTCDate(next.getUTCDate() + interval);
	else if (recurrence.frequency === 'weekly') next.setUTCDate(next.getUTCDate() + interval * 7);
	else next.setUTCMonth(next.getUTCMonth() + interval);
	if (recurrence.until && next > new Date(recurrence.until)) return;
	const created = await client.query(
		`INSERT INTO tasks(tenant_id,title,contact_id,due_at,priority,status,assigned_to,recurrence) VALUES($1,$2,$3,$4,$5,'open',$6,$7) ON CONFLICT DO NOTHING RETURNING id`,
		[
			tenantId,
			row.title,
			row.contact_id,
			next.toISOString(),
			row.priority,
			row.assigned_to,
			recurrence
		]
	);
	if (created.rowCount && row.assigned_to)
		await scheduleTaskReminder(
			client,
			tenantId,
			created.rows[0].id,
			row.assigned_to,
			next.toISOString()
		);
}
export async function getCalendarIcs(
	session: AutomationSession,
	from?: string,
	to?: string,
	pool?: Pool
) {
	if (!session) throw new AutomationError('Sign in to access stewardship tools.', 401);
	const tasks = await listTasks(session, { from, to }, pool);
	const escape = (s: string) =>
		s.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;');
	const lines = [
		'BEGIN:VCALENDAR',
		'VERSION:2.0',
		'PRODID:-//GiveLoom//Stewardship Calendar//EN',
		'CALSCALE:GREGORIAN'
	];
	for (const task of tasks.tasks) {
		if (!task.dueAt) continue;
		const start = new Date(task.dueAt)
			.toISOString()
			.replace(/[-:]/g, '')
			.replace(/\.\d{3}/, '');
		lines.push(
			'BEGIN:VEVENT',
			`UID:${task.id}@giveloom`,
			`DTSTAMP:${new Date()
				.toISOString()
				.replace(/[-:]/g, '')
				.replace(/\.\d{3}/, '')}`,
			`DTSTART:${start}`,
			`SUMMARY:${escape(task.title)}`,
			`DESCRIPTION:${escape(task.contactName ? `Contact: ${task.contactName}` : 'Stewardship task')}\nStatus: ${task.status}`,
			'END:VEVENT'
		);
	}
	lines.push('END:VCALENDAR');
	return lines.join('\r\n') + '\r\n';
}
export async function listNotifications(session: AutomationSession, pool?: Pool) {
	if (!session) throw new AutomationError('Sign in to access stewardship tools.', 401);
	const workspace = await access(session, pool);
	if (session.demo) return { notifications: await demoRead(session, 'notifications') };
	return withTenant(pool ?? getPool(), workspace.tenant.id, session.userId, async (client) => {
		const result = await client.query(
			`SELECT id,title,body,kind,data,task_id AS "taskId",contact_id AS "contactId",created_at AS "createdAt",read_at AS "readAt" FROM user_notifications WHERE tenant_id=$1 AND user_id=$2 ORDER BY created_at DESC LIMIT 200`,
			[workspace.tenant.id, session.userId]
		);
		return { notifications: result.rows };
	});
}
export async function markNotificationRead(session: AutomationSession, id: string, pool?: Pool) {
	if (!session) throw new AutomationError('Sign in to access stewardship tools.', 401);
	const workspace = await access(session, pool);
	if (session.demo) {
		const notification = (await demoRead(session, 'notifications')).find((row) => row.id === id);
		if (!notification) throw new AutomationError('Notification not found.', 404);
		return demoWrite(session, ['owner', 'admin'], (records) => {
			const row = records.notifications?.find((item) => item.id === id);
			if (!row) throw new AutomationError('Notification not found.', 404);
			row.readAt ??= new Date().toISOString();
			return { notification: { id, readAt: row.readAt } };
		});
	}
	return withTenant(pool ?? getPool(), workspace.tenant.id, session.userId, async (client) => {
		const result = await client.query(
			'UPDATE user_notifications SET read_at=COALESCE(read_at,now()) WHERE tenant_id=$1 AND user_id=$2 AND id=$3 RETURNING id,read_at AS "readAt"',
			[workspace.tenant.id, session.userId, id]
		);
		if (!result.rowCount) throw new AutomationError('Notification not found.', 404);
		return { notification: result.rows[0] };
	});
}
export async function listStewardship(session: AutomationSession, contactId?: string, pool?: Pool) {
	if (!session) throw new AutomationError('Sign in to access stewardship tools.', 401);
	const workspace = await access(session, pool);
	if (session.demo)
		return {
			plans: (await demoRead(session, 'stewardship.plans')).filter(
				(plan) => !contactId || plan.contactId === contactId
			)
		};
	return withTenant(pool ?? getPool(), workspace.tenant.id, session.userId, async (client) => {
		const plans = await client.query(
			`SELECT p.id,p.contact_id AS "contactId",c.name AS "contactName",p.owner_id AS "ownerId",p.title,p.goal,p.status,p.review_at AS "reviewAt",p.created_at AS "createdAt" FROM stewardship_plans p JOIN contacts c ON c.tenant_id=p.tenant_id AND c.id=p.contact_id WHERE p.tenant_id=$1 AND ($2::uuid IS NULL OR p.contact_id=$2) ORDER BY p.updated_at DESC LIMIT 200`,
			[workspace.tenant.id, contactId ?? null]
		);
		for (const plan of plans.rows) {
			const steps = await client.query(
				'SELECT id,position,kind,title,due_at AS "dueAt",status,outcome FROM stewardship_steps WHERE tenant_id=$1 AND plan_id=$2 ORDER BY position',
				[workspace.tenant.id, plan.id]
			);
			plan.steps = steps.rows;
		}
		return { plans: plans.rows };
	});
}
export async function saveStewardshipPlan(
	session: AutomationSession,
	input: Record<string, any>,
	pool?: Pool
) {
	if (!session) throw new AutomationError('Sign in to access stewardship tools.', 401);
	const workspace = await access(session, pool);
	const contactId = String(input.contactId ?? '');
	const title = checkText(input.title, 'title', 180, true);
	const goal = checkText(input.goal ?? '', 'goal', 4000);
	const ownerId = input.ownerId ? String(input.ownerId) : session.userId;
	const status = String(input.status ?? 'active');
	if (!planStatuses.has(status)) throw new AutomationError('Plan status is invalid.', 422);
	if (session.demo) {
		if (!workspace.contacts.some((contact) => contact.id === contactId))
			throw new AutomationError('Contact is not in the active tenant.', 404);
		const steps = Array.isArray(input.steps)
			? input.steps.map((step: any, index: number) => ({
					id: step.id || randomUUID(),
					position: index + 1,
					kind: String(step.kind),
					title: checkText(step.title, 'step title', 180, true),
					dueAt: dateValue(step.dueAt, 'step dueAt'),
					status: String(step.status ?? 'open'),
					outcome: checkText(step.outcome ?? '', 'step outcome', 4000)
				}))
			: [];
		return demoWrite(
			session,
			['owner', 'admin', 'fundraising_manager', 'fundraiser'],
			(records) => {
				records['stewardship.plans'] ??= [];
				const id = String(input.id ?? randomUUID());
				const plan = {
					id,
					contactId,
					contactName: workspace.contacts.find((contact) => contact.id === contactId)?.name,
					ownerId,
					title,
					goal,
					status,
					reviewAt: dateValue(input.reviewAt, 'reviewAt'),
					steps,
					updatedAt: new Date().toISOString()
				};
				const found = records['stewardship.plans'].find((row) => row.id === id);
				if (found) Object.assign(found, plan);
				else records['stewardship.plans'].push(plan);
				return { plan };
			}
		);
	}
	return withTenant(pool ?? getPool(), workspace.tenant.id, session.userId, async (client) => {
		const contact = await client.query(
			'SELECT 1 FROM contacts WHERE tenant_id=$1 AND id=$2 AND archived_at IS NULL',
			[workspace.tenant.id, contactId]
		);
		if (!contact.rowCount)
			throw new AutomationError('Contact not found in the active tenant.', 404);
		const owner = await client.query(
			"SELECT 1 FROM memberships WHERE tenant_id=$1 AND user_id=$2 AND status='active'",
			[workspace.tenant.id, ownerId]
		);
		if (!owner.rowCount)
			throw new AutomationError('Plan owner must be an active tenant member.', 422);
		const id = input.id ? String(input.id) : randomUUID();
		const reviewAt = dateValue(input.reviewAt, 'reviewAt');
		let plan;
		if (input.id) {
			const updated = await client.query(
				'UPDATE stewardship_plans SET title=$3,goal=$4,status=$5,owner_id=$6,review_at=$7,updated_at=now() WHERE tenant_id=$1 AND id=$2 AND contact_id=$8 RETURNING id',
				[workspace.tenant.id, id, title, goal, status, ownerId, reviewAt, contactId]
			);
			if (!updated.rowCount)
				throw new AutomationError('Stewardship plan not found for this contact.', 404);
			plan = { id };
		} else {
			const created = await client.query(
				'INSERT INTO stewardship_plans(id,tenant_id,contact_id,owner_id,title,goal,status,review_at,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id',
				[id, workspace.tenant.id, contactId, ownerId, title, goal, status, reviewAt, session.userId]
			);
			plan = created.rows[0];
		}
		if (Array.isArray(input.steps)) {
			await client.query('DELETE FROM stewardship_steps WHERE tenant_id=$1 AND plan_id=$2', [
				workspace.tenant.id,
				id
			]);
			for (let index = 0; index < input.steps.length; index++) {
				const step = input.steps[index];
				if (!step || typeof step !== 'object' || !stepKinds.has(String(step.kind)))
					throw new AutomationError('Stewardship step kind is invalid.', 422);
				const stepTitle = checkText(step.title, 'step title', 180, true);
				const stepStatus = String(step.status ?? 'open');
				if (!['open', 'completed', 'skipped'].includes(stepStatus))
					throw new AutomationError('Stewardship step status is invalid.', 422);
				await client.query(
					'INSERT INTO stewardship_steps(tenant_id,plan_id,position,kind,title,due_at,status,outcome,completed_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
					[
						workspace.tenant.id,
						id,
						index + 1,
						step.kind,
						stepTitle,
						dateValue(step.dueAt, 'step dueAt'),
						stepStatus,
						checkText(step.outcome ?? '', 'step outcome', 4000),
						stepStatus === 'completed' ? new Date() : null
					]
				);
			}
		}
		await client.query(
			'INSERT INTO audit_log(tenant_id,actor_id,action,resource,record_id,details) VALUES($1,$2,$3,$4,$5,$6)',
			[
				workspace.tenant.id,
				session.userId,
				input.id ? 'stewardship.plan_updated' : 'stewardship.plan_created',
				'stewardship_plans',
				id,
				{ contactId }
			]
		);
		return { plan };
	});
}
export async function listProposals(session: AutomationSession, contactId?: string, pool?: Pool) {
	if (!session) throw new AutomationError('Sign in to access stewardship tools.', 401);
	const workspace = await access(session, pool);
	if (session.demo)
		return {
			proposals: (await demoRead(session, 'proposals')).filter(
				(proposal) => !contactId || proposal.contactId === contactId
			)
		};
	return withTenant(pool ?? getPool(), workspace.tenant.id, session.userId, async (client) => {
		const result = await client.query(
			`SELECT p.id,p.contact_id AS "contactId",c.name AS "contactName",p.owner_id AS "ownerId",p.title,p.stage,p.ask_minor AS "askMinor",p.currency,p.expected_close_at AS "expectedCloseAt",p.notes,p.updated_at AS "updatedAt" FROM proposals p JOIN contacts c ON c.tenant_id=p.tenant_id AND c.id=p.contact_id WHERE p.tenant_id=$1 AND ($2::uuid IS NULL OR p.contact_id=$2) ORDER BY p.updated_at DESC LIMIT 200`,
			[workspace.tenant.id, contactId ?? null]
		);
		return { proposals: result.rows };
	});
}
export async function saveProposal(
	session: AutomationSession,
	input: Record<string, unknown>,
	pool?: Pool
) {
	if (!session) throw new AutomationError('Sign in to access stewardship tools.', 401);
	const workspace = await access(session, pool);
	const contactId = String(input.contactId ?? '');
	const title = checkText(input.title, 'title', 180, true);
	const stage = String(input.stage ?? 'discovery');
	if (!proposalStages.has(stage)) throw new AutomationError('Proposal stage is invalid.', 422);
	const askMinor = Number(input.askMinor);
	if (!Number.isSafeInteger(askMinor) || askMinor < 0)
		throw new AutomationError('askMinor must be a non-negative safe integer.', 422);
	const currency = String(input.currency ?? workspace.tenant.currency).toUpperCase();
	if (!/^[A-Z]{3}$/.test(currency))
		throw new AutomationError('currency must be an ISO 4217 code.', 422);
	const expectedClose = input.expectedCloseAt
		? new Date(String(input.expectedCloseAt)).toISOString().slice(0, 10)
		: null;
	const notes = checkText(input.notes ?? '', 'notes', 8000);
	if (session.demo) {
		if (!workspace.contacts.some((contact) => contact.id === contactId))
			throw new AutomationError('Contact not found in the active tenant.', 404);
		return demoWrite(session, ['owner', 'admin', 'fundraising_manager'], (records) => {
			records.proposals ??= [];
			const id = String(input.id ?? randomUUID());
			const proposal = {
				id,
				contactId,
				contactName: workspace.contacts.find((contact) => contact.id === contactId)?.name,
				ownerId: String(input.ownerId ?? session.userId),
				title,
				stage,
				askMinor,
				currency,
				expectedCloseAt: expectedClose,
				notes,
				updatedAt: new Date().toISOString()
			};
			const existing = records.proposals.find((row) => row.id === id);
			if (existing) Object.assign(existing, proposal);
			else records.proposals.push(proposal);
			return { proposal };
		});
	}
	return withTenant(pool ?? getPool(), workspace.tenant.id, session.userId, async (client) => {
		const contact = await client.query(
			'SELECT 1 FROM contacts WHERE tenant_id=$1 AND id=$2 AND archived_at IS NULL',
			[workspace.tenant.id, contactId]
		);
		if (!contact.rowCount)
			throw new AutomationError('Contact not found in the active tenant.', 404);
		const ownerId = String(input.ownerId ?? session.userId);
		const member = await client.query(
			"SELECT 1 FROM memberships WHERE tenant_id=$1 AND user_id=$2 AND status='active'",
			[workspace.tenant.id, ownerId]
		);
		if (!member.rowCount)
			throw new AutomationError('Proposal owner must be an active tenant member.', 422);
		const result = input.id
			? await client.query(
					`UPDATE proposals SET owner_id=$3,title=$4,stage=$5,ask_minor=$6,currency=$7,expected_close_at=$8,notes=$9,updated_at=now() WHERE tenant_id=$1 AND id=$2 AND contact_id=$10 RETURNING id,contact_id AS "contactId",title,stage,ask_minor AS "askMinor",currency,expected_close_at AS "expectedCloseAt",notes`,
					[
						workspace.tenant.id,
						String(input.id),
						ownerId,
						title,
						stage,
						askMinor,
						currency,
						expectedClose,
						notes,
						contactId
					]
				)
			: await client.query(
					`INSERT INTO proposals(tenant_id,contact_id,owner_id,title,stage,ask_minor,currency,expected_close_at,notes,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id,contact_id AS "contactId",title,stage,ask_minor AS "askMinor",currency,expected_close_at AS "expectedCloseAt",notes`,
					[
						workspace.tenant.id,
						contactId,
						ownerId,
						title,
						stage,
						askMinor,
						currency,
						expectedClose,
						notes,
						session.userId
					]
				);
		if (!result.rowCount) throw new AutomationError('Proposal not found for this contact.', 404);
		await client.query(
			'INSERT INTO audit_log(tenant_id,actor_id,action,resource,record_id,details) VALUES($1,$2,$3,$4,$5,$6)',
			[
				workspace.tenant.id,
				session.userId,
				input.id ? 'proposal.updated' : 'proposal.created',
				'proposals',
				result.rows[0].id,
				{ contactId, stage, askMinor }
			]
		);
		return { proposal: result.rows[0] };
	});
}
