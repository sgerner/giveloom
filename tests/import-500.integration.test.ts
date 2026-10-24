import { describe, it, expect, afterAll } from 'vitest';
import {
	createOwnerAccount,
	getPool,
	importContactsPostgres,
	workspaceFromPostgres
} from '../src/lib/server/database';
import { analyzeContactCsv } from '../src/lib/server/csv';
const enabled = Boolean(
	process.env.DATABASE_URL && process.env.RUN_POSTGRES_MUTATION_TESTS === 'true'
);
afterAll(async () => {
	if (enabled) await getPool().end();
});
describe('500-contact reviewed import', () => {
	it.skipIf(!enabled)(
		'imports all clean rows atomically and rejects a repeat without partial changes',
		async () => {
			const suffix = crypto.randomUUID().slice(0, 8),
				slug = 'import-' + suffix;
			const account = await createOwnerAccount({
				email: 'owner-' + suffix + '@example.test',
				name: 'Import owner',
				passwordHash: 'unused-test-hash',
				organizationName: 'Import fixture',
				slug,
				sessionExpiresAt: new Date(Date.now() + 3600000),
				testOnlyVerifiedFixture: true
			});
			const csv =
				'name,email\n' +
				Array.from(
					{ length: 500 },
					(_, i) => 'Supporter ' + i + ',supporter-' + suffix + '-' + i + '@example.test'
				).join('\n');
			const review = analyzeContactCsv(csv, []);
			expect(review.createCount).toBe(500);
			const created = await importContactsPostgres(
				slug,
				account.userId,
				review.rows.map((row) => row.contact!)
			);
			expect(created).toHaveLength(500);
			await expect(
				importContactsPostgres(
					slug,
					account.userId,
					review.rows.map((row) => row.contact!)
				)
			).rejects.toMatchObject({ status: 409 });
			const workspace = await workspaceFromPostgres(slug, account.userId, 'owner');
			expect(workspace?.contacts).toHaveLength(500);
		}
	);
});
