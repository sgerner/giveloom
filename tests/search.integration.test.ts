import { it, expect, afterAll } from 'vitest';
import { getPool, createOwnerAccount, mutatePostgres } from '../src/lib/server/database';
import { searchWorkspace } from '../src/lib/server/search';
const enabled = !!process.env.DATABASE_URL && process.env.RUN_POSTGRES_MUTATION_TESTS === 'true';
afterAll(async () => {
	if (enabled) await getPool().end();
});
it.skipIf(!enabled)(
	'searches only active-member tenant data and does not expose cross-tenant overlapping names',
	async () => {
		const n = crypto.randomUUID().slice(0, 8);
		const accounts = [];
		for (const prefix of ['sa', 'sb'])
			accounts.push(
				await createOwnerAccount({
					email: prefix + n + '@example.test',
					name: 'Search owner',
					passwordHash: 'fixture',
					organizationName: 'Search tests',
					slug: prefix + n,
					sessionExpiresAt: new Date(Date.now() + 3600000),
					testOnlyVerifiedFixture: true
				})
			);
		const [a, b] = accounts;
		const one = (await mutatePostgres(
			'sa' + n,
			a.userId,
			'contacts',
			{ name: 'Shared search person', email: 'same@example.test' },
			'create'
		)) as any;
		const two = (await mutatePostgres(
			'sb' + n,
			b.userId,
			'contacts',
			{ name: 'Shared search person', email: 'same@example.test' },
			'create'
		)) as any;
		const result = await searchWorkspace(
			{ userId: a.userId, tenantSlug: 'sa' + n, role: 'owner', demo: false },
			'Shared search'
		);
		expect(result.items.map((x) => x.id)).toContain(one.id);
		expect(result.items.map((x) => x.id)).not.toContain(two.id);
		await expect(
			searchWorkspace(
				{ userId: a.userId, tenantSlug: 'sb' + n, role: 'owner', demo: false },
				'Shared'
			)
		).rejects.toMatchObject({ status: 403 });
	}
);
