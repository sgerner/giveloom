import { afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createOwnerAccount, getPool } from '../src/lib/server/database';
import {
	createReportDefinition,
	dispatchDueReportSchedules,
	isIsoReportDate,
	listReportDefinitions,
	nextReportRunAt,
	ReportScheduleError,
	scheduleReport,
	updateReportDefinition
} from '../src/lib/server/report-schedules';

const enabled =
	Boolean(process.env.DATABASE_URL) && process.env.RUN_POSTGRES_MUTATION_TESTS === 'true';

describe('saved report schedule safety', () => {
	it('accepts only real calendar dates for report filters', () => {
		expect(isIsoReportDate('2026-02-28')).toBe(true);
		expect(isIsoReportDate('2024-02-29')).toBe(true);
		expect(isIsoReportDate('2026-02-29')).toBe(false);
		expect(isIsoReportDate('2026-02-31')).toBe(false);
		expect(isIsoReportDate('0000-01-01')).toBe(false);
		expect(isIsoReportDate('2026-2-03')).toBe(false);
	});

	it('calculates scheduled wall-clock times in the selected timezone', () => {
		const now = new Date('2026-10-23T16:30:00.000Z');
		expect(nextReportRunAt(now, 'weekly', '09:00', 'America/Phoenix', 5).toISOString()).toBe(
			'2026-10-30T16:00:00.000Z'
		);
		expect(nextReportRunAt(now, 'daily', '09:00', 'America/Phoenix').toISOString()).toBe(
			'2026-10-24T16:00:00.000Z'
		);
	});

	it.skipIf(!enabled)(
		'saves an approved schedule, queues one tenant event, and pauses after its definition changes',
		async () => {
			const suffix = randomUUID().replaceAll('-', '').slice(0, 12),
				slug = `reports-${suffix}`;
			const account = await createOwnerAccount({
				email: `owner-${suffix}@example.test`,
				name: 'Report Owner',
				passwordHash: 'test-only-hash',
				organizationName: `Reports ${suffix}`,
				slug,
				sessionExpiresAt: new Date(Date.now() + 60_000),
				testOnlyVerifiedFixture: true
			});
			const session = { userId: account.userId, tenantSlug: slug, role: 'owner', demo: false };
			const tenant = await getPool().query('SELECT id FROM tenants WHERE slug=$1', [slug]);
			const tenantId = String(tenant.rows[0].id);
			await expect(
				createReportDefinition(session, {
					name: 'Invalid date report',
					reportKey: 'giving',
					filters: { from: '2026-02-31' }
				})
			).rejects.toMatchObject({ status: 422 } satisfies Partial<ReportScheduleError>);
			const saved = await createReportDefinition(session, {
				name: 'Ledger summary',
				reportKey: 'giving',
				filters: { currency: 'USD' }
			});
			const definitionId = String(saved.definition.id);
			const schedule = await scheduleReport(
				session,
				{ definitionId, frequency: 'daily', localTime: '08:00', timezone: 'UTC', approved: true },
				getPool(),
				new Date('2026-10-23T00:00:00Z')
			);
			expect(schedule.schedule.status).toBe('active');
			const dueAt = new Date(Date.parse(String(schedule.schedule.nextRunAt)) + 60_000);
			const queued = await dispatchDueReportSchedules(getPool(), tenantId, dueAt);
			const diagnostic = await listReportDefinitions(session);
			expect(queued, JSON.stringify(diagnostic.definitions)).toBe(1);
			const state = await listReportDefinitions(session);
			expect(state.definitions[0]).toMatchObject({ id: definitionId, scheduleStatus: 'active' });
			expect(state.deliveries[0]?.status).toBe('queued');
			const updated = await updateReportDefinition(session, definitionId, {
				name: 'Ledger summary revised',
				reportKey: 'giving',
				filters: { currency: 'USD' }
			});
			expect(updated.schedulePaused).toBe(true);
			const after = await listReportDefinitions(session);
			expect(after.definitions[0]?.scheduleStatus).toBe('paused');
		}
	);
});

afterAll(async () => {
	if (enabled) await getPool().end();
});
