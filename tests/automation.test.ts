import { afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { Queue, QueueEvents, Worker } from 'bullmq';
import { createOwnerAccount, getPool, mutatePostgres } from '../src/lib/server/database';
import {
	createAutomation,
	dispatchDueTenantWork,
	handleAutomationStepOutboxEvent,
	publishAutomation,
	startManualAutomation,
	simulateAutomation,
	nextAllowedWorkflowTime,
	enqueueAutomationTrigger,
	validateWorkflowDefinition,
	type AutomationOutboxEvent
} from '../src/lib/server/automation';

const enabled =
	Boolean(process.env.DATABASE_URL) && process.env.RUN_POSTGRES_MUTATION_TESTS === 'true';

describe('automation workflow safety', () => {
	it('rejects missing edges and cycles', () => {
		expect(
			validateWorkflowDefinition({
				trigger: { type: 'manual' },
				startId: 'a',
				nodes: [{ id: 'a', type: 'wait', minutes: 1, next: 'missing' }]
			}).valid
		).toBe(false);
		expect(
			validateWorkflowDefinition({
				trigger: { type: 'manual' },
				startId: 'a',
				nodes: [{ id: 'a', type: 'wait', minutes: 1, next: 'a' }]
			}).valid
		).toBe(false);
	});

	it('validates the expanded trigger, condition, and guarded action families', () => {
		const triggers = [
			{ type: 'first_gift' },
			{ type: 'recurring_gift_failed' },
			{ type: 'donation_anniversary' },
			{ type: 'birthday', fieldId: randomUUID(), requireConsent: true },
			{ type: 'contact.tagged', tag: 'volunteer' },
			{ type: 'segment.entry', segmentId: randomUUID() },
			{ type: 'segment.exit', segmentId: randomUUID() },
			{ type: 'pledge.overdue', daysOverdue: 2 },
			{ type: 'form.submitted', formId: 'donation-form' },
			{ type: 'email.engagement', engagement: 'clicked' },
			{ type: 'inactivity', days: 90 },
			{ type: 'prospect.score_threshold', threshold: 80 }
		];
		for (const trigger of triggers) {
			expect(
				validateWorkflowDefinition({
					trigger,
					startId: 'done',
					nodes: [{ id: 'done', type: 'exit' }]
				}).valid
			).toBe(true);
		}
		const condition = {
			id: 'check',
			type: 'condition',
			field: 'contact.relationshipConfidence',
			operator: 'greater_or_equal',
			value: 0.8,
			whenTrue: 'webhook',
			whenFalse: 'done'
		};
		const webhook = {
			id: 'webhook',
			type: 'action',
			action: 'webhook',
			endpointId: randomUUID(),
			eventName: 'workflow.review',
			next: 'done'
		};
		expect(
			validateWorkflowDefinition({
				trigger: { type: 'manual' },
				startId: 'check',
				nodes: [condition, webhook, { id: 'done', type: 'exit' }]
			}).valid
		).toBe(true);
		expect(
			validateWorkflowDefinition({
				trigger: { type: 'manual' },
				startId: 'field',
				nodes: [
					{ id: 'field', type: 'action', action: 'update_field', next: 'done' },
					{ id: 'done', type: 'exit' }
				]
			}).valid
		).toBe(false);
		expect(
			validateWorkflowDefinition({
				trigger: { type: 'manual' },
				startId: 'tag',
				nodes: [
					{ id: 'tag', type: 'action', action: 'add_tag', next: 'done' },
					{ id: 'done', type: 'exit' }
				]
			}).valid
		).toBe(false);
		expect(
			validateWorkflowDefinition({
				trigger: { type: 'manual' },
				startId: 'stage',
				nodes: [
					{ id: 'stage', type: 'action', action: 'update_stage', next: 'done' },
					{ id: 'done', type: 'exit' }
				]
			}).valid
		).toBe(false);
	});

	it('defers workflow runs through quiet hours in the tenant timezone', () => {
		const result = nextAllowedWorkflowTime(
			new Date('2026-10-24T07:00:00.000Z'),
			'America/Phoenix',
			{ start: '22:00', end: '06:00' }
		);
		expect(result.toISOString()).toBe('2026-10-24T13:00:00.000Z');
	});

	it('ignores malformed automation step numbers before touching the database', async () => {
		const event = {
			tenantId: randomUUID(),
			eventType: 'automation.step',
			payload: { runId: randomUUID(), stepNumber: 1.5 }
		};
		await expect(
			handleAutomationStepOutboxEvent(event, {
				connect: () => {
					throw new Error('Database should not be touched.');
				}
			} as never)
		).resolves.toBeUndefined();
	});

	it.skipIf(!enabled)(
		'avoids a scheduler FK/advisory-lock deadlock with an overdue trigger',
		async () => {
			const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
			const slug = `automation-lock-${suffix}`;
			const account = await createOwnerAccount({
				email: `owner-${suffix}@example.test`,
				name: 'Automation Owner',
				passwordHash: 'test-only-hash',
				organizationName: `Automation ${suffix}`,
				slug,
				sessionExpiresAt: new Date(Date.now() + 60_000),
				testOnlyVerifiedFixture: true
			});
			const session = { userId: account.userId, tenantSlug: slug, role: 'owner', demo: false };
			const contact = await mutatePostgres(
				slug,
				account.userId,
				'contacts',
				{ name: 'Automation Contact', email: `contact-${suffix}@example.test` },
				'create'
			);
			const contactId = String((contact as Record<string, unknown>).id);
			const tenant = await getPool().query('SELECT id FROM tenants WHERE slug=$1', [slug]);
			const tenantId = String(tenant.rows[0].id);
			const pledge = await withTenantQuery(
				tenantId,
				"INSERT INTO pledges(tenant_id,contact_id,amount_minor,currency,status) VALUES($1,$2,1000,'USD','active') RETURNING id",
				[tenantId, contactId]
			);
			await withTenantQuery(
				tenantId,
				"INSERT INTO pledge_installments(tenant_id,pledge_id,amount_minor,due_at) VALUES($1,$2,1000,now()-interval '1 day')",
				[tenantId, pledge.rows[0].id]
			);
			const created = await createAutomation(session, {
				name: 'Overdue pledge workflow',
				definition: {
					trigger: { type: 'pledge.overdue', daysOverdue: 0 },
					startId: 'finish',
					nodes: [{ id: 'finish', type: 'exit' }],
					frequencyCapHours: 24
				}
			});
			const automationId = String(created.automation.id);
			await publishAutomation(session, automationId);
			await withTenantQuery(
				tenantId,
				"UPDATE automation_definitions SET next_schedule_at=now()-interval '1 minute' WHERE tenant_id=$1 AND id=$2",
				[tenantId, automationId]
			);

			const holder = await getPool().connect();
			let eventPromise: Promise<unknown> | undefined;
			let schedulerPromise: Promise<unknown> | undefined;
			try {
				await holder.query('BEGIN');
				await holder.query("SELECT set_config('app.tenant_id',$1,true)", [tenantId]);
				await holder.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
					`${tenantId}:${automationId}:${contactId}`
				]);
				eventPromise = enqueueAutomationTrigger({
					id: randomUUID(),
					tenantId,
					eventType: 'pledges.overdue',
					payload: { contactId }
				});
				await waitForAdvisoryWaiters(1);
				schedulerPromise = dispatchDueTenantWork(getPool(), tenantId);
				await waitForAdvisoryWaiters(2);
				await holder.query('COMMIT');
				await Promise.race([
					Promise.all([eventPromise, schedulerPromise]),
					new Promise((_, reject) =>
						setTimeout(() => reject(new Error('Scheduler/event lock sequence timed out.')), 5000)
					)
				]);
			} finally {
				await holder.query('ROLLBACK').catch(() => undefined);
				holder.release();
				await Promise.allSettled(
					[eventPromise, schedulerPromise].filter(Boolean) as Promise<unknown>[]
				);
			}
		}
	);

	it.skipIf(!enabled)(
		'serializes frequency-cap checks for concurrent distinct trigger events',
		async () => {
			const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
			const slug = `automation-cap-${suffix}`;
			const account = await createOwnerAccount({
				email: `owner-${suffix}@example.test`,
				name: 'Automation Owner',
				passwordHash: 'test-only-hash',
				organizationName: `Automation ${suffix}`,
				slug,
				sessionExpiresAt: new Date(Date.now() + 60_000),
				testOnlyVerifiedFixture: true
			});
			const session = { userId: account.userId, tenantSlug: slug, role: 'owner', demo: false };
			const contact = await mutatePostgres(
				slug,
				account.userId,
				'contacts',
				{ name: 'Automation Contact', email: `contact-${suffix}@example.test` },
				'create'
			);
			const contactId = String((contact as Record<string, unknown>).id);
			const created = await createAutomation(session, {
				name: 'Capped contact workflow',
				definition: {
					trigger: { type: 'contact.created' },
					startId: 'finish',
					nodes: [{ id: 'finish', type: 'exit' }],
					frequencyCapHours: 24
				}
			});
			const automationId = String(created.automation.id);
			const tenant = await getPool().query('SELECT id FROM tenants WHERE slug=$1', [slug]);
			const tenantId = String(tenant.rows[0].id);
			await publishAutomation(session, automationId);
			const events = [randomUUID(), randomUUID()].map((id) => ({
				id,
				tenantId,
				eventType: 'contacts.created',
				payload: { recordId: contactId }
			}));
			await Promise.all(events.map((event) => enqueueAutomationTrigger(event)));
			const runs = await withTenantQuery(
				tenantId,
				'SELECT state,context FROM automation_runs WHERE tenant_id=$1 AND automation_id=$2',
				[tenantId, automationId]
			);
			expect(runs.rows).toHaveLength(2);
			expect(runs.rows.filter((run) => run.state === 'queued')).toHaveLength(1);
			expect(runs.rows.filter((run) => run.context?.skipped === 'frequency_cap')).toHaveLength(1);
		}
	);

	it.skipIf(!enabled)(
		'executes durable action steps idempotently and leaves simulations without side effects',
		async () => {
			const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
			const slug = `automation-${suffix}`;
			const account = await createOwnerAccount({
				email: `owner-${suffix}@example.test`,
				name: 'Automation Owner',
				passwordHash: 'test-only-hash',
				organizationName: `Automation ${suffix}`,
				slug,
				sessionExpiresAt: new Date(Date.now() + 60_000),
				testOnlyVerifiedFixture: true
			});
			const session = { userId: account.userId, tenantSlug: slug, role: 'owner', demo: false };
			const contact = await mutatePostgres(
				slug,
				account.userId,
				'contacts',
				{ name: 'Automation Contact', email: `contact-${suffix}@example.test` },
				'create'
			);
			const contactId = String((contact as Record<string, unknown>).id);
			const definition = {
				trigger: { type: 'manual' },
				startId: 'task',
				nodes: [
					{
						id: 'task',
						type: 'action',
						action: 'create_task',
						title: 'Thank donor',
						dueInHours: 0,
						next: 'finish'
					},
					{ id: 'finish', type: 'exit' }
				],
				frequencyCapHours: 0
			};
			const created = await createAutomation(session, { name: 'Thank-you workflow', definition });
			const automationId = String(created.automation.id);
			const before = await getPool().query('SELECT id FROM tenants WHERE slug=$1', [slug]);
			const tenantId = String(before.rows[0].id);
			await publishAutomation(session, automationId);
			const beforeSimulation = await withTenantQuery(
				tenantId,
				'SELECT count(*)::int AS count FROM tasks WHERE tenant_id=$1',
				[tenantId]
			);
			const simulated = await simulateAutomation(session, automationId, contactId);
			expect(simulated.sideEffects).toBe(false);
			expect(simulated.steps).toHaveLength(2);
			const afterSimulation = await withTenantQuery(
				tenantId,
				'SELECT count(*)::int AS count FROM tasks WHERE tenant_id=$1',
				[tenantId]
			);
			expect(afterSimulation.rows[0].count).toBe(beforeSimulation.rows[0].count);
			const started = await startManualAutomation(session, automationId, contactId);
			expect(started.status).toBe('queued');
			const runId = String(started.runId);
			const event = { tenantId, eventType: 'automation.step', payload: { runId, stepNumber: 1 } };
			const redisBinary =
				process.env.REDIS_SERVER_BINARY ?? '/tmp/giveloom-runtime/redis-7.4.2/src/redis-server';
			if (existsSync(redisBinary)) {
				const worker = await createRedisWorker(redisBinary, (data) =>
					handleAutomationStepOutboxEvent(data)
				);
				try {
					await worker.process(event, `${runId}-1`);
					await handleAutomationStepOutboxEvent(event);
					const next = { ...event, payload: { runId, stepNumber: 2 } };
					await worker.process(next, `${runId}-2`);
					await handleAutomationStepOutboxEvent(next);
				} finally {
					await worker.close();
				}
			} else {
				await handleAutomationStepOutboxEvent(event);
				await handleAutomationStepOutboxEvent(event);
				await handleAutomationStepOutboxEvent({ ...event, payload: { runId, stepNumber: 2 } });
				await handleAutomationStepOutboxEvent({ ...event, payload: { runId, stepNumber: 2 } });
			}
			const tasks = await withTenantQuery(
				tenantId,
				"SELECT id FROM tasks WHERE tenant_id=$1 AND contact_id=$2 AND title='Thank donor'",
				[tenantId, contactId]
			);
			expect(tasks.rowCount).toBe(1);
			const runs = await withTenantQuery(
				tenantId,
				'SELECT state,step_number FROM automation_runs WHERE tenant_id=$1 AND id=$2',
				[tenantId, runId]
			);
			expect(runs.rows[0]).toMatchObject({ state: 'completed', step_number: 2 });
		}
	);
});

async function withTenantQuery(tenantId: string, sql: string, params: unknown[]) {
	const client = await getPool().connect();
	try {
		await client.query('BEGIN');
		await client.query("SELECT set_config('app.tenant_id',$1,true)", [tenantId]);
		const result = await client.query(sql, params);
		await client.query('COMMIT');
		return result;
	} catch (error) {
		await client.query('ROLLBACK');
		throw error;
	} finally {
		client.release();
	}
}

async function waitForAdvisoryWaiters(expected: number) {
	const deadline = Date.now() + 5000;
	while (Date.now() < deadline) {
		const result = await getPool().query(
			"SELECT count(*)::int AS count FROM pg_stat_activity WHERE wait_event_type='Lock' AND wait_event='advisory' AND query LIKE '%pg_advisory_xact_lock(hashtextextended%'"
		);
		if (Number(result.rows[0].count) >= expected) return;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error(`Timed out waiting for ${expected} advisory-lock waiters.`);
}

async function createRedisWorker(
	redisBinary: string,
	processEvent: (event: AutomationOutboxEvent) => Promise<unknown>
) {
	const directory = await mkdtemp(join(tmpdir(), 'giveloom-automation-redis-'));
	const listener = createServer();
	await new Promise<void>((resolve, reject) => {
		listener.once('error', reject);
		listener.listen(0, '127.0.0.1', resolve);
	});
	const address = listener.address();
	if (!address || typeof address === 'string')
		throw new Error('Unable to allocate local Redis port.');
	const port = address.port;
	await new Promise<void>((resolve) => listener.close(() => resolve()));
	const redis = spawn(
		redisBinary,
		[
			'--bind',
			'127.0.0.1',
			'--port',
			String(port),
			'--save',
			'',
			'--appendonly',
			'no',
			'--dir',
			directory
		],
		{ stdio: 'ignore' }
	);
	const queueName = `automation-integration-${randomUUID()}`;
	const connection = { host: '127.0.0.1', port, maxRetriesPerRequest: null as null };
	const queue = new Queue(queueName, { connection });
	const events = new QueueEvents(queueName, { connection });
	const worker = new Worker(
		queueName,
		async (job) => processEvent(job.data as AutomationOutboxEvent),
		{ connection }
	);
	try {
		await Promise.all([queue.waitUntilReady(), events.waitUntilReady(), worker.waitUntilReady()]);
		return {
			process: async (event: AutomationOutboxEvent, jobId: string) => {
				const job = await queue.add('automation.step', event, { jobId, removeOnComplete: false });
				await job.waitUntilFinished(events, 10000);
			},
			close: async () => {
				await worker.close();
				await events.close();
				await queue.close();
				redis.kill('SIGTERM');
				await new Promise<void>((resolve) => redis.once('exit', () => resolve()));
				await rm(directory, { recursive: true, force: true });
			}
		};
	} catch (error) {
		await worker.close().catch(() => undefined);
		await events.close().catch(() => undefined);
		await queue.close().catch(() => undefined);
		redis.kill('SIGTERM');
		await rm(directory, { recursive: true, force: true });
		throw error;
	}
}

afterAll(async () => {
	if (enabled) await getPool().end();
});
