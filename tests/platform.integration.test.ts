import { it, expect, afterAll, vi } from 'vitest';
import { createOwnerAccount, getPool, workspaceFromPostgres } from '../src/lib/server/database';
import { platformCommand, platformAudit } from '../src/lib/server/platform';
const enabled = !!process.env.DATABASE_URL && process.env.RUN_POSTGRES_MUTATION_TESTS === 'true';
afterAll(async () => {
	vi.unstubAllEnvs();
	if (enabled) await getPool().end();
});
it.skipIf(!enabled)(
	'gates tenant creation, suspension, restoration and platform audit to configured operators',
	async () => {
		const n = crypto.randomUUID().slice(0, 8),
			email = 'platform-' + n + '@example.test',
			slug = 'operator-' + n;
		const a = await createOwnerAccount({
			email,
			name: 'Operator fixture',
			passwordHash: 'fixture',
			organizationName: 'Operator workspace',
			slug,
			sessionExpiresAt: new Date(Date.now() + 3600000),
			testOnlyVerifiedFixture: true
		});
		const session = { userId: a.userId, tenantSlug: slug, role: 'owner', demo: false };
		vi.stubEnv('PLATFORM_ADMIN_EMAILS', email);
		const created = await platformCommand(session, {
			action: 'create',
			slug: 'managed-' + n,
			legalName: 'Managed tenant',
			currency: 'USD',
			timezone: 'America/Phoenix',
			confirmed: true
		});
		expect(created.slug).toBe('managed-' + n);
		expect(await workspaceFromPostgres(created.slug, a.userId, 'owner')).not.toBeNull();
		await platformCommand(session, {
			action: 'suspend',
			tenantId: created.id,
			reason: 'Test suspension requested by operator',
			confirmed: true
		});
		expect(await workspaceFromPostgres(created.slug, a.userId, 'owner')).toBeNull();
		await platformCommand(session, {
			action: 'resume',
			tenantId: created.id,
			reason: 'Test suspension resolved by operator',
			confirmed: true
		});
		expect(await workspaceFromPostgres(created.slug, a.userId, 'owner')).not.toBeNull();
		expect(
			(await platformAudit(session)).items.filter((r) => r.tenantId === created.id)
		).toHaveLength(3);
		expect((await getPool().query('SELECT id FROM platform_audit_events')).rowCount).toBe(0);
		vi.stubEnv('PLATFORM_ADMIN_EMAILS', 'another@example.test');
		await expect(platformAudit(session)).rejects.toMatchObject({ status: 403 });
	}
);
