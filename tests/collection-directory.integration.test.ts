import { afterAll, describe, expect, it } from 'vitest';
import { createOwnerAccount, getPool, mutatePostgres } from '../src/lib/server/database';
import { GET as collectionsGet } from '../src/routes/api/v1/collections/[resource]/+server';

const enabled = !!process.env.DATABASE_URL && process.env.RUN_POSTGRES_MUTATION_TESTS === 'true';
afterAll(async () => {
	if (enabled) await getPool().end();
});

describe('scalable collection directory', () => {
	it.skipIf(!enabled)(
		'pages beyond compact workspace limits and returns full member and segment summaries with role checks',
		async () => {
			const slug = `collection-${crypto.randomUUID().slice(0, 8)}`;
			const account = await createOwnerAccount({
				email: `${slug}@example.test`,
				name: 'Collection Owner',
				passwordHash: 'fixture',
				organizationName: 'Collection tests',
				slug,
				sessionExpiresAt: new Date(Date.now() + 3_600_000),
				testOnlyVerifiedFixture: true
			});
			const session = { userId: account.userId, tenantSlug: slug, role: 'owner', demo: false };
			for (let i = 0; i < 105; i++)
				await mutatePostgres(
					slug,
					account.userId,
					'organizations',
					{ name: `Directory Org ${String(i).padStart(3, '0')}`, website: '' },
					'create'
				);
			const contact = (await mutatePostgres(
				slug,
				account.userId,
				'contacts',
				{ name: 'Household Member', email: 'member@example.test' },
				'create'
			)) as any;
			await mutatePostgres(
				slug,
				account.userId,
				'households',
				{ name: 'Paged household', memberIds: [contact.id] },
				'create'
			);
			await mutatePostgres(
				slug,
				account.userId,
				'segments',
				{
					name: 'All active members',
					rules: [{ field: 'stage', operator: 'equals', value: 'new' }]
				},
				'create'
			);
			const call = (resource: string, params = '') =>
				collectionsGet({
					params: { resource },
					url: new URL(`http://localhost/api/v1/collections/${resource}?${params}`),
					locals: { session }
				} as any);
			const firstResponse = await call('organizations', 'limit=100');
			const first = await firstResponse.json();
			expect(firstResponse.status).toBe(200);
			expect(first.total).toBe(105);
			expect(first.items).toHaveLength(100);
			expect(first.nextCursor).toBeTruthy();
			const secondResponse = await call(
				'organizations',
				`limit=100&cursor=${encodeURIComponent(first.nextCursor)}`
			);
			const second = await secondResponse.json();
			expect(second.items).toHaveLength(5);
			expect(second.nextCursor).toBeNull();
			const householdResponse = await call('households');
			const household = await householdResponse.json();
			expect(household.items[0].memberNames).toEqual(['Household Member']);
			const segmentResponse = await call('segments');
			const segment = await segmentResponse.json();
			expect(segment.items[0].matchingContactCount).toBe(1);
			const client = await getPool().connect();
			try {
				await client.query('BEGIN');
				await client.query("SELECT set_config('app.tenant_id',$1,true)", [account.tenantId]);
				await client.query('UPDATE memberships SET role=$3 WHERE tenant_id=$1 AND user_id=$2', [
					account.tenantId,
					account.userId,
					'read_only'
				]);
				await client.query('COMMIT');
			} finally {
				client.release();
			}
			const denied = await call('households');
			expect(denied.status).toBe(403);
		}
	);
});
