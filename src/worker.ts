import { Worker, Queue, type Job } from 'bullmq';
import IORedis from 'ioredis';
import pg from 'pg';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Pool as PgPool, PoolClient } from 'pg';
import {
	dispatchScheduledEmailBatches,
	handleEmailConsentOutboxEvent,
	handleEmailOutboxEvent
} from '$lib/server/communications';
import {
	dispatchDueReportSchedules,
	handleReportDeliveryOutboxEvent
} from '$lib/server/report-schedules';
import {
	dispatchWebhookSubscriptions,
	handleWebhookDeliveryOutboxEvent,
	runTenantRetentionMaintenance
} from '$lib/server/admin';
import { sendOperatorTransactionalEmail, sendTransactionalEmail } from '$lib/server/communications';
import { handlePortalMagicLinkOutboxEvent } from '$lib/server/portal';
import { handleGiftRecordedOutboxEvent } from '$lib/server/receipts';
import { handleIdentityEmailOutboxEvent } from '$lib/server/identity';
import {
	dispatchDueTenantWork,
	enqueueAutomationTrigger,
	handleAutomationStepOutboxEvent,
	handleTaskReminderOutboxEvent,
	markAutomationRunFailed,
	noopKnownDomainEvent
} from '$lib/server/automation';

const { Pool } = pg;
const QUEUE_NAME = 'donor-crm-outbox';
const REDIS_URL = process.env.REDIS_URL ?? 'redis://redis:6379';
const DATABASE_URL = process.env.DATABASE_URL;
const JOB_SIGNING_SECRET = process.env.JOB_SIGNING_SECRET;
const POLL_INTERVAL_MS = Number(process.env.OUTBOX_POLL_INTERVAL_MS ?? 1000);

export type OutboxEvent = {
	id: string;
	tenantId: string;
	eventType: string;
	payload: unknown;
	idempotencyKey: string;
	contextSignature: string;
};
export type OutboxHandler = (event: OutboxEvent) => Promise<void>;

export function signTenantContext(
	event: Omit<OutboxEvent, 'contextSignature'>,
	secret: string
): string {
	const { contextSignature: _signature, ...unsigned } = event as OutboxEvent;
	return createHmac('sha256', secret).update(JSON.stringify(unsigned)).digest('hex');
}

export function hasValidTenantContext(event: OutboxEvent, secret: string): boolean {
	const expected = Buffer.from(signTenantContext(event, secret), 'hex');
	const actual = Buffer.from(event.contextSignature, 'hex');
	return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function safeErrorMessage(error: unknown): string {
	const message = error instanceof Error ? error.message : 'Unknown worker error';
	return message
		.replace(/\b(?:sk|rk|pk|whsec)_[A-Za-z0-9_-]+\b/gi, '[redacted credential]')
		.replace(/Bearer\s+[^\s]+/gi, 'Bearer [redacted]')
		.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[redacted email]')
		.replace(/postgres(?:ql)?:\/\/[^@\s]+@[^\s]+/gi, '[redacted database url]')
		.slice(0, 1000);
}

/** Handlers use this to make PostgreSQL RLS apply to every job-side query. */
export async function withTenantTransaction<T>(
	pool: PgPool,
	tenantId: string,
	callback: (client: PoolClient) => Promise<T>
): Promise<T> {
	const client = await pool.connect();
	try {
		await client.query('BEGIN');
		await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
		const value = await callback(client);
		await client.query('COMMIT');
		return value;
	} catch (error) {
		await client.query('ROLLBACK').catch(() => undefined);
		throw error;
	} finally {
		client.release();
	}
}

/** Registration point for real event handlers. Unknown events fail visibly and are never reported as complete. */
export const outboxHandlers = new Map<string, OutboxHandler>();

export async function handleOutboxJob(job: Job<OutboxEvent>): Promise<void> {
	if (!JOB_SIGNING_SECRET || !hasValidTenantContext(job.data, JOB_SIGNING_SECRET))
		throw new Error('Invalid or missing tenant context signature');
	const handler = outboxHandlers.get(job.data.eventType);
	if (!handler)
		throw new Error(`No handler configured for outbox event type: ${job.data.eventType}`);
	await handler(job.data);
}

export async function startWorker() {
	if (!DATABASE_URL) throw new Error('DATABASE_URL is required by the worker');
	if (!JOB_SIGNING_SECRET || JOB_SIGNING_SECRET.length < 32)
		throw new Error('JOB_SIGNING_SECRET must contain at least 32 characters');
	const pool = new Pool({ connectionString: DATABASE_URL, max: 5 });
	outboxHandlers.set('email.send', (event) => handleEmailOutboxEvent(event, pool));
	outboxHandlers.set('email.consent_request', (event) =>
		handleEmailConsentOutboxEvent(event, pool, sendTransactionalEmail)
	);
	outboxHandlers.set('automation.step', (event) => handleAutomationStepOutboxEvent(event, pool));
	outboxHandlers.set('report.deliver', (event) => handleReportDeliveryOutboxEvent(event, pool));
	outboxHandlers.set('webhook.deliver', (event) => handleWebhookDeliveryOutboxEvent(event, pool));
	outboxHandlers.set('task.reminder', (event) => handleTaskReminderOutboxEvent(event, pool));
	outboxHandlers.set('portal.magic_link', (event) =>
		handlePortalMagicLinkOutboxEvent(event, pool, sendTransactionalEmail)
	);
	const giftRecorded = async (event: OutboxEvent) => {
		await handleGiftRecordedOutboxEvent(event, pool);
		await enqueueAutomationTrigger(event, pool);
		await dispatchWebhookSubscriptions(event, pool);
		await noopKnownDomainEvent(event, pool);
	};
	outboxHandlers.set('gift.recorded', giftRecorded);
	outboxHandlers.set('gifts.created', giftRecorded);
	outboxHandlers.set('identity.email', (event) =>
		handleIdentityEmailOutboxEvent(event, pool, sendOperatorTransactionalEmail)
	);
	const observedDomainEvent = async (event: OutboxEvent) => {
		await enqueueAutomationTrigger(event, pool);
		await dispatchWebhookSubscriptions(event, pool);
		await noopKnownDomainEvent(event, pool);
	};
	for (const eventType of [
		'contacts.created',
		'contact.created',
		'contacts.updated',
		'contacts.archived',
		'contact.merged',
		'contact.merge_undone',
		'tasks.created',
		'tasks.updated',
		'tasks.archived',
		'campaigns.created',
		'campaigns.updated',
		'campaigns.archived',
		'events.created',
		'events.updated',
		'events.archived',
		'prospects.created',
		'prospects.updated',
		'prospects.archived',
		'introductions.created',
		'introductions.updated',
		'introductions.archived',
		'email_drafts.created',
		'email_drafts.updated',
		'files.created',
		'files.archived',
		'donation.recorded',
		'payment.refunded',
		'automation.action',
		'recurring.gift.failed',
		'segments.entered',
		'segments.exited',
		'pledges.overdue',
		'forms.submitted',
		'email.delivered',
		'email.opened',
		'email.clicked',
		'contacts.inactive',
		'prospects.score_threshold'
	])
		outboxHandlers.set(eventType, observedDomainEvent);
	const redis = new IORedis(REDIS_URL, { maxRetriesPerRequest: null, enableReadyCheck: true });
	const redisUrl = new URL(REDIS_URL);
	const redisConnection = {
		host: redisUrl.hostname,
		port: Number(redisUrl.port || 6379),
		username: redisUrl.username ? decodeURIComponent(redisUrl.username) : undefined,
		password: redisUrl.password ? decodeURIComponent(redisUrl.password) : undefined,
		db: redisUrl.pathname.length > 1 ? Number(redisUrl.pathname.slice(1)) : 0,
		maxRetriesPerRequest: null as null,
		enableReadyCheck: true,
		...(redisUrl.protocol === 'rediss:' ? { tls: {} } : {})
	};
	const queue = new Queue<OutboxEvent, void, string>(QUEUE_NAME, { connection: redisConnection });
	const worker = new Worker<OutboxEvent, void, string>(QUEUE_NAME, handleOutboxJob, {
		connection: redisConnection,
		concurrency: Number(process.env.WORKER_CONCURRENCY ?? 4),
		limiter: { max: 100, duration: 1000 }
	});
	worker.on('failed', async (job, error) => {
		// Do not log payloads, donor data, addresses, or provider credentials.
		const safeMessage = safeErrorMessage(error);
		console.error(
			JSON.stringify({
				level: 'error',
				event: 'job_failed',
				jobId: job?.id,
				eventType: job?.data.eventType,
				error: safeMessage
			})
		);
		if (job?.data.id && JOB_SIGNING_SECRET && hasValidTenantContext(job.data, JOB_SIGNING_SECRET))
			await withTenantTransaction(pool, job.data.tenantId, (client) =>
				client
					.query(
						'UPDATE outbox_events SET attempts = $2, last_error = $3 WHERE tenant_id = $1 AND id = $4',
						[job.data.tenantId, job.attemptsMade, safeMessage, job.data.id]
					)
					.then(() => undefined)
			).catch((updateError: unknown) => {
				console.error(
					JSON.stringify({
						level: 'error',
						event: 'job_failure_status_update_failed',
						jobId: job.id,
						error: updateError instanceof Error ? updateError.message : 'unknown'
					})
				);
			});
		if (
			job?.data.eventType === 'automation.step' &&
			job.attemptsMade >= Number(job.opts.attempts ?? 1)
		)
			await markAutomationRunFailed(job.data, error, pool).catch((failureError: unknown) => {
				console.error(
					JSON.stringify({
						level: 'error',
						event: 'automation_failure_record_failed',
						jobId: job.id,
						error: safeErrorMessage(failureError)
					})
				);
			});
	});
	worker.on('completed', (job) =>
		console.info(
			JSON.stringify({
				level: 'info',
				event: 'job_completed',
				jobId: job.id,
				eventType: job.data.eventType
			})
		)
	);
	await redis.ping();
	await pool.query('SELECT 1');
	const readyPath = '/tmp/worker-ready';
	await import('node:fs/promises').then(({ writeFile }) =>
		writeFile(readyPath, new Date().toISOString())
	);
	let stopping = false;
	const poll = async () => {
		while (!stopping) {
			try {
				// The tenant directory is global; all outbox reads/writes run with FORCE RLS context.
				const tenants = await pool.query<{ id: string }>('SELECT id FROM tenants ORDER BY id');
				for (const { id: tenantId } of tenants.rows) {
					await dispatchDueTenantWork(pool, tenantId);
					await dispatchScheduledEmailBatches(pool, tenantId);
					await dispatchDueReportSchedules(pool, tenantId);
					await runTenantRetentionMaintenance(pool, tenantId);
					const client = await pool.connect();
					try {
						await client.query('BEGIN');
						await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
						const result = await client.query<{
							id: string;
							tenant_id: string;
							event_type: string;
							payload: unknown;
							idempotency_key: string;
						}>(
							`SELECT id, tenant_id, event_type, payload, idempotency_key
						   FROM outbox_events WHERE tenant_id = $1 AND processed_at IS NULL
						   ORDER BY created_at LIMIT 50 FOR UPDATE SKIP LOCKED`,
							[tenantId]
						);
						for (const row of result.rows) {
							const unsigned = {
								id: row.id,
								tenantId: row.tenant_id,
								eventType: row.event_type,
								payload: row.payload,
								idempotencyKey: row.idempotency_key
							};
							const event: OutboxEvent = {
								...unsigned,
								contextSignature: signTenantContext(unsigned, JOB_SIGNING_SECRET)
							};
							try {
								await queue.add(event.eventType, event, {
									jobId: event.id,
									attempts: 8,
									backoff: { type: 'exponential', delay: 1000 },
									removeOnComplete: false,
									removeOnFail: false
								});
								await client.query(
									'UPDATE outbox_events SET processed_at = now(), last_error = NULL WHERE tenant_id = $1 AND id = $2',
									[tenantId, event.id]
								);
							} catch (error) {
								const detail = safeErrorMessage(error);
								await client.query(
									'UPDATE outbox_events SET attempts = attempts + 1, last_error = $3 WHERE tenant_id = $1 AND id = $2',
									[tenantId, event.id, detail]
								);
								console.error(
									JSON.stringify({
										level: 'error',
										event: 'outbox_event_dispatch_failed',
										eventId: event.id,
										eventType: event.eventType,
										error: detail
									})
								);
							}
						}
						await client.query('COMMIT');
					} catch (error) {
						await client.query('ROLLBACK').catch(() => undefined);
						console.error(
							JSON.stringify({
								level: 'error',
								event: 'tenant_outbox_dispatch_failed',
								tenantId,
								error: error instanceof Error ? error.message : 'unknown'
							})
						);
					} finally {
						client.release();
					}
				}
			} catch (error) {
				console.error(
					JSON.stringify({
						level: 'error',
						event: 'tenant_enumeration_failed',
						error: error instanceof Error ? error.message : 'unknown'
					})
				);
			}
			await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
		}
	};
	const poller = poll();
	const shutdown = async () => {
		if (stopping) return;
		stopping = true;
		await worker.close();
		await queue.close();
		await pool.end();
		await redis.quit();
		await import('node:fs/promises').then(({ rm }) => rm(readyPath, { force: true }));
		await poller;
	};
	process.once('SIGTERM', () => void shutdown());
	process.once('SIGINT', () => void shutdown());
	return { shutdown };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	startWorker().catch((error: unknown) => {
		console.error(
			JSON.stringify({
				level: 'fatal',
				event: 'worker_start_failed',
				error: error instanceof Error ? error.message : 'unknown'
			})
		);
		process.exitCode = 1;
	});
}
