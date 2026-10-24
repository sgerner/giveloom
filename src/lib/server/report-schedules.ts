import { canonicalContactId } from '$lib/identity';
import { segmentMatches } from './communications';
import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { getPool } from './database';
import { CommunicationError, sendOperatorTransactionalEmail } from './communications';
import { ledgerReport, donorRetention, type GiftRow, type ReportFilter } from '$lib/reporting';

export type ReportSession = NonNullable<App.Locals['session']>;
export class ReportScheduleError extends Error {
	constructor(
		message: string,
		readonly status: number
	) {
		super(message);
		this.name = 'ReportScheduleError';
	}
}
const allowedRoles = new Set([
	'owner',
	'admin',
	'fundraising_manager',
	'fundraiser',
	'finance',
	'finance_manager',
	'analyst'
]);
const sha = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const idSchema = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const timeSchema = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
export function isIsoReportDate(value: string) {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000-')) return false;
	const parsed = new Date(`${value}T00:00:00.000Z`);
	return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

async function tenantFor(session: ReportSession, pool: Pool) {
	if (!allowedRoles.has(session.role))
		throw new ReportScheduleError('Your role cannot save or schedule reports.', 403);
	const tenant = await pool.query('SELECT id,timezone,currency FROM tenants WHERE slug=$1', [
		session.tenantSlug
	]);
	if (!tenant.rowCount) throw new ReportScheduleError('Active workspace is unavailable.', 403);
	return tenant.rows[0] as { id: string; timezone: string; currency: string };
}
async function scoped<T>(
	pool: Pool,
	tenantId: string,
	userId: string | null,
	fn: (client: PoolClient) => Promise<T>
) {
	const client = await pool.connect();
	try {
		await client.query('BEGIN');
		await client.query("SELECT set_config('app.tenant_id',$1,true)", [tenantId]);
		if (userId) {
			const membership = await client.query(
				"SELECT 1 FROM memberships WHERE tenant_id=$1 AND user_id=$2 AND status='active'",
				[tenantId, userId]
			);
			if (!membership.rowCount)
				throw new ReportScheduleError('Active tenant membership is unavailable.', 403);
		}
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
function validateDefinition(input: unknown) {
	if (!input || typeof input !== 'object' || Array.isArray(input))
		throw new ReportScheduleError('Report definition must be an object.', 422);
	const row = input as Record<string, unknown>;
	const name = typeof row.name === 'string' ? row.name.trim() : '';
	const reportKey = String(row.reportKey ?? '');
	if (!name || name.length > 160)
		throw new ReportScheduleError('Report name must be between 1 and 160 characters.', 422);
	if (!['giving', 'retention'].includes(reportKey))
		throw new ReportScheduleError('Choose a supported report.', 422);
	const filters = row.filters ?? {};
	if (!filters || typeof filters !== 'object' || Array.isArray(filters))
		throw new ReportScheduleError('Report filters must be an object.', 422);
	const f = filters as Record<string, unknown>;
	const normalized: ReportFilter = {};
	for (const key of ['from', 'to'] as const) {
		if (f[key] !== undefined) {
			const value = String(f[key]);
			if (!isIsoReportDate(value))
				throw new ReportScheduleError(`${key} must be an ISO date.`, 422);
			normalized[key] = value;
		}
	}
	if (f.campaignId !== undefined) {
		const value = String(f.campaignId);
		if (!idSchema.test(value)) throw new ReportScheduleError('Campaign filter is invalid.', 422);
		normalized.campaignId = value;
	}
	for (const key of ['fundId', 'ownerId', 'segmentId'] as const) {
		if (f[key] !== undefined) {
			const value = String(f[key]);
			if (!idSchema.test(value)) throw new ReportScheduleError(`${key} filter is invalid.`, 422);
			normalized[key] = value;
		}
	}
	if (f.currency !== undefined) {
		const currency = String(f.currency).toUpperCase();
		if (!/^[A-Z]{3}$/.test(currency))
			throw new ReportScheduleError('Currency must be an ISO 4217 code.', 422);
		normalized.currency = currency;
	}
	if (normalized.from && normalized.to && normalized.from > normalized.to)
		throw new ReportScheduleError('Start date must be before end date.', 422);
	if (reportKey === 'retention' && f.year !== undefined) {
		const year = Number(f.year);
		if (!Number.isInteger(year) || year < 2000 || year > 2200)
			throw new ReportScheduleError('Retention year is invalid.', 422);
		(normalized as ReportFilter & { year?: number }).year = year;
	}
	return { name, reportKey, filters: normalized };
}
function localParts(date: Date, timezone: string) {
	const parts = new Intl.DateTimeFormat('en-US', {
		timeZone: timezone,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		weekday: 'short',
		hour: '2-digit',
		minute: '2-digit',
		hourCycle: 'h23'
	}).formatToParts(date);
	const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
	return {
		year: Number(get('year')),
		month: Number(get('month')),
		day: Number(get('day')),
		hour: Number(get('hour')),
		minute: Number(get('minute')),
		weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'))
	};
}
function utcFromLocal(
	year: number,
	month: number,
	day: number,
	hour: number,
	minute: number,
	timezone: string
) {
	const target = Date.UTC(year, month - 1, day, hour, minute);
	let guess = target;
	for (let index = 0; index < 4; index++) {
		const p = localParts(new Date(guess), timezone);
		const represented = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
		guess += target - represented;
	}
	return new Date(guess);
}
export function nextReportRunAt(
	now: Date,
	frequency: 'daily' | 'weekly' | 'monthly',
	localTime: string,
	timezone: string,
	weekday?: number
) {
	if (!timeSchema.test(localTime))
		throw new ReportScheduleError('Choose a valid local delivery time.', 422);
	let p;
	try {
		p = localParts(now, timezone);
	} catch {
		throw new ReportScheduleError('Choose a valid IANA timezone.', 422);
	}
	const [hour, minute] = localTime.split(':').map(Number);
	let year = p.year,
		month = p.month,
		day = p.day;
	if (frequency === 'weekly') {
		if (!Number.isInteger(weekday) || weekday! < 0 || weekday! > 6)
			throw new ReportScheduleError('Choose a weekday for weekly delivery.', 422);
		let delta = (weekday! - p.weekday + 7) % 7;
		if (delta === 0 && (hour! < p.hour || (hour === p.hour && minute! <= p.minute))) delta = 7;
		const next = new Date(Date.UTC(year, month - 1, day + delta));
		year = next.getUTCFullYear();
		month = next.getUTCMonth() + 1;
		day = next.getUTCDate();
	} else if (frequency === 'monthly') {
		if (day > 1 || (day === 1 && (hour! < p.hour || (hour === p.hour && minute! <= p.minute)))) {
			month++;
			if (month > 12) {
				month = 1;
				year++;
			}
		}
		day = 1;
	} else if (hour! < p.hour || (hour === p.hour && minute! <= p.minute)) {
		const next = new Date(Date.UTC(year, month - 1, day + 1));
		year = next.getUTCFullYear();
		month = next.getUTCMonth() + 1;
		day = next.getUTCDate();
	}
	return utcFromLocal(year, month, day, hour!, minute!, timezone);
}
function approvedHash(input: {
	tenantId: string;
	ownerId: string;
	definitionId: string;
	name: string;
	reportKey: string;
	filters: unknown;
	frequency: string;
	localTime: string;
	weekday: number | null;
	timezone: string;
}) {
	return sha(input);
}

export async function listReportDefinitions(session: ReportSession, pool: Pool = getPool()) {
	const tenant = await tenantFor(session, pool);
	return scoped(pool, tenant.id, session.userId, async (client) => {
		const definitions = await client.query(
			`SELECT d.id,d.name,d.report_key AS "reportKey",d.filters,d.created_at AS "createdAt",d.updated_at AS "updatedAt",s.id AS "scheduleId",s.frequency,s.local_time AS "localTime",s.weekday,s.timezone,s.status AS "scheduleStatus",s.next_run_at AS "nextRunAt",s.last_run_at AS "lastRunAt" FROM saved_report_definitions d LEFT JOIN saved_report_schedules s ON s.tenant_id=d.tenant_id AND s.definition_id=d.id WHERE d.tenant_id=$1 AND d.owner_id=$2 ORDER BY d.updated_at DESC`,
			[tenant.id, session.userId]
		);
		const deliveries = await client.query(
			`SELECT id,schedule_id AS "scheduleId",status,scheduled_for AS "scheduledFor",created_at AS "createdAt",completed_at AS "completedAt",last_error AS "lastError" FROM report_deliveries WHERE tenant_id=$1 AND owner_id=$2 ORDER BY created_at DESC LIMIT 30`,
			[tenant.id, session.userId]
		);
		const account = await client.query(
			'SELECT email,email_verified_at IS NOT NULL AS verified FROM users WHERE id=$1 AND disabled_at IS NULL',
			[session.userId]
		);
		return {
			definitions: definitions.rows,
			deliveries: deliveries.rows,
			recipient: account.rows[0]
				? { email: account.rows[0].email, verified: Boolean(account.rows[0].verified) }
				: null
		};
	});
}
export async function createReportDefinition(
	session: ReportSession,
	input: unknown,
	pool: Pool = getPool()
) {
	const normalized = validateDefinition(input);
	const tenant = await tenantFor(session, pool);
	return scoped(pool, tenant.id, session.userId, async (client) => {
		const result = await client.query(
			`INSERT INTO saved_report_definitions(tenant_id,owner_id,name,report_key,filters) VALUES($1,$2,$3,$4,$5) RETURNING id,name,report_key AS "reportKey",filters,created_at AS "createdAt",updated_at AS "updatedAt"`,
			[tenant.id, session.userId, normalized.name, normalized.reportKey, normalized.filters]
		);
		await client.query(
			"INSERT INTO audit_log(tenant_id,actor_id,action,resource,record_id,details) VALUES($1,$2,'report.definition_created','saved_report_definitions',$3,$4)",
			[
				tenant.id,
				session.userId,
				result.rows[0].id,
				{ reportKey: normalized.reportKey, filterKeys: Object.keys(normalized.filters) }
			]
		);
		return { definition: result.rows[0] };
	});
}
export async function updateReportDefinition(
	session: ReportSession,
	id: string,
	input: unknown,
	pool: Pool = getPool()
) {
	if (!idSchema.test(id)) throw new ReportScheduleError('Report id is invalid.', 422);
	const normalized = validateDefinition(input);
	const tenant = await tenantFor(session, pool);
	return scoped(pool, tenant.id, session.userId, async (client) => {
		const result = await client.query(
			`UPDATE saved_report_definitions SET name=$4,report_key=$5,filters=$6,updated_at=now() WHERE tenant_id=$1 AND owner_id=$2 AND id=$3 RETURNING id,name,report_key AS "reportKey",filters,updated_at AS "updatedAt"`,
			[tenant.id, session.userId, id, normalized.name, normalized.reportKey, normalized.filters]
		);
		if (!result.rowCount) throw new ReportScheduleError('Saved report not found.', 404);
		await client.query(
			"UPDATE saved_report_schedules SET status='paused',updated_at=now() WHERE tenant_id=$1 AND definition_id=$2 AND status='active'",
			[tenant.id, id]
		);
		await client.query(
			"INSERT INTO audit_log(tenant_id,actor_id,action,resource,record_id,details) VALUES($1,$2,'report.definition_updated','saved_report_definitions',$3,$4)",
			[tenant.id, session.userId, id, { schedulePaused: true }]
		);
		return { definition: result.rows[0], schedulePaused: true };
	});
}
export async function scheduleReport(
	session: ReportSession,
	input: unknown,
	pool: Pool = getPool(),
	now = new Date()
) {
	if (!input || typeof input !== 'object' || Array.isArray(input))
		throw new ReportScheduleError('Schedule input is invalid.', 422);
	const row = input as Record<string, unknown>;
	const definitionId = String(row.definitionId ?? '');
	if (!idSchema.test(definitionId))
		throw new ReportScheduleError('Saved report id is invalid.', 422);
	if (row.approved !== true)
		throw new ReportScheduleError(
			'Confirm scheduled delivery to your verified account email.',
			422
		);
	const frequency = String(row.frequency ?? '') as 'daily' | 'weekly' | 'monthly';
	if (!['daily', 'weekly', 'monthly'].includes(frequency))
		throw new ReportScheduleError('Choose daily, weekly, or monthly delivery.', 422);
	const localTime = String(row.localTime ?? '09:00');
	if (!timeSchema.test(localTime))
		throw new ReportScheduleError('Choose a valid local delivery time.', 422);
	const tenant = await tenantFor(session, pool);
	const timezone = String(row.timezone ?? tenant.timezone);
	const weekday = frequency === 'weekly' ? Number(row.weekday) : null;
	const nextRunAt = nextReportRunAt(now, frequency, localTime, timezone, weekday ?? undefined);
	return scoped(pool, tenant.id, session.userId, async (client) => {
		const verified = await client.query(
			'SELECT 1 FROM users WHERE id=$1 AND email_verified_at IS NOT NULL AND disabled_at IS NULL',
			[session.userId]
		);
		if (!verified.rowCount)
			throw new ReportScheduleError('Verify your account email before scheduling delivery.', 403);
		const definition = await client.query(
			'SELECT id,name,report_key,filters FROM saved_report_definitions WHERE tenant_id=$1 AND owner_id=$2 AND id=$3 FOR UPDATE',
			[tenant.id, session.userId, definitionId]
		);
		if (!definition.rowCount) throw new ReportScheduleError('Saved report not found.', 404);
		const saved = definition.rows[0];
		const approvalHash = approvedHash({
			tenantId: tenant.id,
			ownerId: session.userId,
			definitionId,
			name: saved.name,
			reportKey: saved.report_key,
			filters: saved.filters,
			frequency,
			localTime,
			weekday,
			timezone
		});
		const result = await client.query(
			`INSERT INTO saved_report_schedules(tenant_id,definition_id,owner_id,frequency,local_time,weekday,timezone,next_run_at,approval_hash,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'active') ON CONFLICT(tenant_id,definition_id) DO UPDATE SET frequency=EXCLUDED.frequency,local_time=EXCLUDED.local_time,weekday=EXCLUDED.weekday,timezone=EXCLUDED.timezone,next_run_at=EXCLUDED.next_run_at,approval_hash=EXCLUDED.approval_hash,status='active',updated_at=now() RETURNING id`,
			[
				tenant.id,
				definitionId,
				session.userId,
				frequency,
				localTime,
				weekday,
				timezone,
				nextRunAt,
				approvalHash
			]
		);
		const scheduleId = result.rows[0].id;
		await client.query(
			"INSERT INTO audit_log(tenant_id,actor_id,action,resource,record_id,details) VALUES($1,$2,'report.schedule_approved','saved_report_schedules',$3,$4)",
			[
				tenant.id,
				session.userId,
				scheduleId,
				{ frequency, timezone, localTime, recipient: 'verified account email', approvalHash }
			]
		);
		return {
			schedule: {
				id: scheduleId,
				definitionId,
				frequency,
				localTime,
				weekday,
				timezone,
				nextRunAt,
				status: 'active'
			}
		};
	});
}

export async function pauseReportSchedule(
	session: ReportSession,
	scheduleId: string,
	pool: Pool = getPool()
) {
	if (!idSchema.test(scheduleId)) throw new ReportScheduleError('Schedule id is invalid.', 422);
	const tenant = await tenantFor(session, pool);
	return scoped(pool, tenant.id, session.userId, async (client) => {
		const result = await client.query(
			"UPDATE saved_report_schedules SET status='paused',updated_at=now() WHERE tenant_id=$1 AND owner_id=$2 AND id=$3 RETURNING id",
			[tenant.id, session.userId, scheduleId]
		);
		if (!result.rowCount) throw new ReportScheduleError('Report schedule not found.', 404);
		await client.query(
			"INSERT INTO audit_log(tenant_id,actor_id,action,resource,record_id,details) VALUES($1,$2,'report.schedule_paused','saved_report_schedules',$3,'{}')",
			[tenant.id, session.userId, scheduleId]
		);
		return { paused: true };
	});
}
function csvCell(value: unknown) {
	const text = String(value ?? '');
	return `"${text.replaceAll('"', '""')}"`;
}
async function buildReport(
	client: PoolClient,
	tenantId: string,
	reportKey: string,
	filters: ReportFilter
) {
	const result = await client.query(
		`SELECT g.id,g.contact_id AS "contactId",g.campaign_id AS "campaignId",g.amount_minor AS "amountMinor",g.currency,g.status,g.kind,g.occurred_at AS "occurredAt",g.created_at AS "createdAt",g.data->>'direction' AS direction FROM gifts g LEFT JOIN contacts c ON c.tenant_id=g.tenant_id AND c.id=g.contact_id WHERE g.tenant_id=$1 AND ($2::uuid IS NULL OR g.fund_id=$2) AND ($3::uuid IS NULL OR c.data->>'ownerId'=$3::text) ORDER BY g.occurred_at,g.id`,
		[tenantId, filters.fundId || null, filters.ownerId || null]
	);
	let gifts = result.rows.map((row) => ({
		...row,
		amountMinor: Number(row.amountMinor),
		currency: String(row.currency).trim()
	})) as GiftRow[];
	if (filters.segmentId) {
		const segment = await client.query(
			"SELECT data FROM workspace_records WHERE tenant_id=$1 AND resource='segments' AND id=$2 AND archived_at IS NULL",
			[tenantId, filters.segmentId]
		);
		if (!segment.rowCount)
			throw new ReportScheduleError('Saved segment is no longer available.', 409);
		const contacts = await client.query(
			'SELECT id,name,email,stage,tags,data FROM contacts WHERE tenant_id=$1',
			[tenantId]
		);
		const ids = new Set(
			contacts.rows
				.filter((c) =>
					segmentMatches({ ...c.data, ...c }, segment.rows[0].data.rules || segment.rows[0].data)
				)
				.map((c) => c.id)
		);
		gifts = gifts.filter((g) => g.contactId && ids.has(g.contactId));
	}
	const aliases = await client.query(
		'SELECT id,merged_into AS "mergedInto" FROM contacts WHERE tenant_id=$1 AND merged_into IS NOT NULL',
		[tenantId]
	);
	gifts = gifts.map((g) => ({
		...g,
		contactId: g.contactId ? canonicalContactId(g.contactId, aliases.rows) : undefined
	}));
	let values: Record<string, string | number | null>;
	if (reportKey === 'retention') {
		const year =
			Number((filters as ReportFilter & { year?: number }).year) || new Date().getUTCFullYear();
		values = donorRetention(gifts, year);
	} else {
		const report = ledgerReport(gifts, filters);
		values = {
			snapshotAt: report.snapshotAt,
			currency: report.currency,
			grossMinor: report.grossMinor,
			refundMinor: report.refundMinor,
			disputeMinor: report.disputeMinor,
			reinstatementMinor: report.reinstatementMinor,
			netRecordedMinor: report.netRecordedMinor,
			pledgedMinor: report.pledgedMinor,
			donorCount: report.donorCount,
			giftCount: report.giftCount
		};
	}
	return Object.entries(values)
		.map(([key, value]) => `${csvCell(key)},${csvCell(value)}`)
		.join('\n');
}
function scheduleApprovalHash(row: {
	tenant_id: string;
	owner_id: string;
	definition_id: string;
	name: string;
	report_key: string;
	filters: unknown;
	frequency: string;
	local_time: string;
	weekday: number | null;
	timezone: string;
}) {
	return approvedHash({
		tenantId: row.tenant_id,
		ownerId: row.owner_id,
		definitionId: row.definition_id,
		name: row.name,
		reportKey: row.report_key,
		filters: row.filters,
		frequency: row.frequency,
		localTime: String(row.local_time).slice(0, 5),
		weekday: row.weekday,
		timezone: row.timezone
	});
}
export async function dispatchDueReportSchedules(pool: Pool, tenantId: string, now = new Date()) {
	return scoped(pool, tenantId, null, async (client) => {
		const due = await client.query(
			`SELECT s.id,s.tenant_id,s.definition_id,s.owner_id,s.frequency,s.local_time,s.weekday,s.timezone,s.next_run_at,s.approval_hash,d.name,d.report_key,d.filters,m.status AS membership_status,u.disabled_at,u.email_verified_at FROM saved_report_schedules s JOIN saved_report_definitions d ON d.tenant_id=s.tenant_id AND d.id=s.definition_id LEFT JOIN memberships m ON m.tenant_id=s.tenant_id AND m.user_id=s.owner_id LEFT JOIN users u ON u.id=s.owner_id WHERE s.tenant_id=$1 AND s.status='active' AND s.next_run_at<=$2 ORDER BY s.next_run_at LIMIT 25 FOR UPDATE OF s SKIP LOCKED`,
			[tenantId, now]
		);
		let queued = 0;
		for (const row of due.rows) {
			const hash = scheduleApprovalHash(row);
			if (
				hash !== String(row.approval_hash).trim() ||
				row.membership_status !== 'active' ||
				row.disabled_at ||
				!row.email_verified_at
			) {
				await client.query(
					"UPDATE saved_report_schedules SET status='paused',updated_at=now() WHERE tenant_id=$1 AND id=$2",
					[tenantId, row.id]
				);
				await client.query(
					"INSERT INTO audit_log(tenant_id,action,resource,record_id,details) VALUES($1,'report.schedule_paused_invalidated','saved_report_schedules',$2,$3)",
					[
						tenantId,
						row.id,
						{ reason: hash !== row.approval_hash ? 'approval_changed' : 'owner_unavailable' }
					]
				);
				continue;
			}
			const scheduledFor = new Date(row.next_run_at);
			const delivery = await client.query(
				`INSERT INTO report_deliveries(tenant_id,schedule_id,owner_id,scheduled_for,report_hash) VALUES($1,$2,$3,$4,$5) ON CONFLICT(tenant_id,schedule_id,scheduled_for) DO NOTHING RETURNING id`,
				[tenantId, row.id, row.owner_id, scheduledFor, hash]
			);
			if (delivery.rowCount) {
				const deliveryId = String(delivery.rows[0].id);
				await client.query(
					`INSERT INTO outbox_events(tenant_id,event_type,payload,idempotency_key) VALUES($1,'report.deliver',$2,$3) ON CONFLICT(idempotency_key) DO NOTHING`,
					[tenantId, { scheduleId: row.id, deliveryId }, `report-delivery:${deliveryId}`]
				);
				queued++;
			}
			let next = nextReportRunAt(
				scheduledFor,
				row.frequency,
				String(row.local_time).slice(0, 5),
				row.timezone,
				row.weekday ?? undefined
			);
			while (next <= now)
				next = nextReportRunAt(
					next,
					row.frequency,
					String(row.local_time).slice(0, 5),
					row.timezone,
					row.weekday ?? undefined
				);
			await client.query(
				'UPDATE saved_report_schedules SET next_run_at=$3,last_run_at=$4,updated_at=now() WHERE tenant_id=$1 AND id=$2',
				[tenantId, row.id, next, scheduledFor]
			);
		}
		return queued;
	});
}
export async function handleReportDeliveryOutboxEvent(
	event: { tenantId: string; payload: unknown },
	pool: Pool = getPool()
) {
	const payload = event.payload as { deliveryId?: unknown; scheduleId?: unknown };
	if (
		typeof payload?.deliveryId !== 'string' ||
		typeof payload.scheduleId !== 'string' ||
		!idSchema.test(payload.deliveryId) ||
		!idSchema.test(payload.scheduleId)
	)
		throw new ReportScheduleError('Report delivery event is invalid.', 422);
	const data = await scoped(pool, event.tenantId, null, async (client) => {
		const result = await client.query(
			`SELECT r.id,r.status,r.owner_id,r.scheduled_for,r.report_hash,s.id AS schedule_id,s.status AS schedule_status,s.approval_hash,s.frequency,s.local_time,s.weekday,s.timezone,d.id AS definition_id,d.name,d.report_key,d.filters,m.status AS membership_status,u.email,u.display_name,u.email_verified_at,u.disabled_at FROM report_deliveries r JOIN saved_report_schedules s ON s.tenant_id=r.tenant_id AND s.id=r.schedule_id AND s.owner_id=r.owner_id JOIN saved_report_definitions d ON d.tenant_id=s.tenant_id AND d.id=s.definition_id JOIN memberships m ON m.tenant_id=r.tenant_id AND m.user_id=r.owner_id JOIN users u ON u.id=r.owner_id WHERE r.tenant_id=$1 AND r.id=$2 AND s.id=$3 FOR UPDATE OF r,s`,
			[event.tenantId, payload.deliveryId, payload.scheduleId]
		);
		if (!result.rowCount) return null;
		const row = result.rows[0];
		if (row.status === 'sent' || row.status === 'cancelled') return null;
		const hash = scheduleApprovalHash({
			...row,
			tenant_id: event.tenantId,
			owner_id: row.owner_id
		});
		if (
			row.schedule_status !== 'active' ||
			row.membership_status !== 'active' ||
			row.disabled_at ||
			!row.email_verified_at ||
			hash !== String(row.approval_hash).trim() ||
			hash !== String(row.report_hash).trim()
		) {
			await client.query(
				"UPDATE report_deliveries SET status='cancelled',last_error='Approved report configuration or verified account is unavailable.',completed_at=now() WHERE tenant_id=$1 AND id=$2",
				[event.tenantId, row.id]
			);
			return null;
		}
		const csv = await buildReport(client, event.tenantId, row.report_key, row.filters);
		await client.query(
			"UPDATE report_deliveries SET status='queued',last_error=NULL WHERE tenant_id=$1 AND id=$2",
			[event.tenantId, row.id]
		);
		return {
			id: String(row.id),
			ownerId: String(row.owner_id),
			email: String(row.email),
			name: String(row.display_name),
			reportName: String(row.name),
			reportKey: String(row.report_key),
			scheduledFor: new Date(row.scheduled_for),
			csv
		};
	});
	if (!data) return;
	try {
		const sent = await sendOperatorTransactionalEmail(
			event.tenantId,
			{
				to: data.email,
				name: data.name,
				subject: `Scheduled report: ${data.reportName}`,
				text: `Your ${data.reportKey} report is ready.\n\nThis report was generated at ${new Date().toISOString()} from your approved saved report definition.\n\n${data.csv}\n\nThis report contains tenant CRM information. Keep it in a secure location.`,
				idempotencyKey: `report-delivery:${payload.deliveryId}`
			},
			pool
		);
		await scoped(pool, event.tenantId, null, async (client) => {
			await client.query(
				"UPDATE report_deliveries SET status='sent',provider_message_id=$3,last_error=NULL,completed_at=now() WHERE tenant_id=$1 AND id=$2 AND status<>'sent'",
				[event.tenantId, payload.deliveryId, sent.providerMessageId ?? sent.id]
			);
			await client.query(
				"INSERT INTO audit_log(tenant_id,actor_id,action,resource,record_id,details) VALUES($1,$2,'report.delivered','report_deliveries',$3,$4)",
				[
					event.tenantId,
					data.ownerId,
					payload.deliveryId,
					{ reportKey: data.reportKey, recipientUserId: data.ownerId, providerStatus: sent.status }
				]
			);
		});
	} catch (error) {
		await scoped(pool, event.tenantId, null, async (client) => {
			await client.query(
				"UPDATE report_deliveries SET status='failed',last_error=$3,completed_at=now() WHERE tenant_id=$1 AND id=$2 AND status<>'sent'",
				[
					event.tenantId,
					payload.deliveryId,
					error instanceof CommunicationError ? error.message : 'Report delivery failed.'
				]
			);
		});
		throw error;
	}
}
export function reportScheduleErrorStatus(error: unknown) {
	return error instanceof ReportScheduleError
		? error.status
		: error instanceof CommunicationError
			? error.status
			: 503;
}
