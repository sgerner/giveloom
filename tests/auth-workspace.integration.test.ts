import { afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import {
	getPool,
	createOwnerAccount,
	authenticate,
	registerSession,
	validateSession,
	revokeSession,
	workspaceFromPostgres,
	mutatePostgres,
	previewPostgresContactMerge,
	mergePostgresContacts,
	undoPostgresContactMerge
} from '../src/lib/server/database';

const enabled =
	Boolean(process.env.DATABASE_URL) && process.env.RUN_POSTGRES_MUTATION_TESTS === 'true';
describe('PostgreSQL account and workspace integration', () => {
	it.skipIf(!enabled)(
		'creates a tenant owner, authenticates, revokes sessions and enforces resource permissions',
		async () => {
			const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
			const email = `integration-${suffix}@example.test`;
			const slug = `integration-${suffix}`;
			const password = await argon2.hash('a-test-only-password-long-enough', {
				type: argon2.argon2id,
				memoryCost: 19456,
				timeCost: 2,
				parallelism: 1
			});
			const account = await createOwnerAccount({
				email,
				name: 'Integration Owner',
				passwordHash: password,
				organizationName: `Integration Org ${suffix}`,
				slug,
				sessionExpiresAt: new Date(Date.now() + 60_000),
				testOnlyVerifiedFixture: true
			});
			const ownerSession = {
				userId: account.userId,
				tenantSlug: slug,
				role: 'owner',
				demo: false,
				sessionId: account.sessionId,
				sessionVersion: account.sessionVersion
			};
			expect(await validateSession(ownerSession)).toBe(true);
			const authenticated = await authenticate(email, slug);
			expect(authenticated?.id).toBe(account.userId);
			expect(
				await argon2.verify(authenticated!.password_hash, 'a-test-only-password-long-enough')
			).toBe(true);
			const secondSessionId = await registerSession(
				account.userId,
				slug,
				account.sessionVersion,
				new Date(Date.now() + 60_000)
			);
			expect(await validateSession({ ...ownerSession, sessionId: secondSessionId })).toBe(true);
			await revokeSession({ ...ownerSession, sessionId: secondSessionId });
			expect(await validateSession({ ...ownerSession, sessionId: secondSessionId })).toBe(false);

			const contact = await mutatePostgres(
				slug,
				account.userId,
				'contacts',
				{ name: 'Integration Contact', email: `contact-${suffix}@example.test` },
				'create'
			);
			const contactId = String((contact as Record<string, unknown>).id);
			const task = await mutatePostgres(
				slug,
				account.userId,
				'tasks',
				{
					title: 'Integration task',
					contactId,
					contactEmail: `hidden-${suffix}@example.test`,
					privateNotes: 'Internal follow-up',
					profile: {
						email: `nested-${suffix}@example.test`,
						address: 'private',
						sensitiveNotes: 'confidential'
					}
				},
				'create'
			);
			const taskId = String((task as Record<string, unknown>).id);
			const gift = await mutatePostgres(
				slug,
				account.userId,
				'gifts',
				{ contactId, amountMinor: 12345, currency: 'USD', kind: 'one_time', status: 'recorded' },
				'create'
			);
			const giftId = String((gift as Record<string, unknown>).id);
			const tenant = await getPool().query('SELECT id FROM tenants WHERE slug=$1', [slug]);
			const client = await getPool().connect();
			const marketerId = randomUUID();
			const volunteerId = randomUUID();
			try {
				await client.query('BEGIN');
				await client.query("SELECT set_config('app.tenant_id',$1,true)", [tenant.rows[0].id]);
				const persistedTask = await client.query(
					'SELECT contact_id FROM tasks WHERE tenant_id=$1 AND id=$2',
					[tenant.rows[0].id, taskId]
				);
				expect(persistedTask.rows[0].contact_id).toBe(contactId);
				await client.query("SELECT set_config('app.signup_user_id',$1,true)", [marketerId]);
				await client.query(
					'INSERT INTO users(id,email,display_name,password_hash) VALUES($1,$2,$3,$4)',
					[marketerId, `marketer-${suffix}@example.test`, 'Integration Marketer', 'test-only-hash']
				);
				await client.query("SELECT set_config('app.signup_user_id','',true)");
				await client.query(
					"INSERT INTO memberships(tenant_id,user_id,role,status) VALUES($1,$2,'marketer','active')",
					[tenant.rows[0].id, marketerId]
				);
				await client.query("SELECT set_config('app.signup_user_id',$1,true)", [volunteerId]);
				await client.query(
					'INSERT INTO users(id,email,display_name,password_hash) VALUES($1,$2,$3,$4)',
					[
						volunteerId,
						`volunteer-${suffix}@example.test`,
						'Integration Volunteer',
						'test-only-hash'
					]
				);
				await client.query("SELECT set_config('app.signup_user_id','',true)");
				await client.query(
					"INSERT INTO memberships(tenant_id,user_id,role,status) VALUES($1,$2,'volunteer','active')",
					[tenant.rows[0].id, volunteerId]
				);
				await client.query('COMMIT');
			} catch (error) {
				await client.query('ROLLBACK');
				throw error;
			} finally {
				client.release();
			}
			const workspace = await workspaceFromPostgres(slug, account.userId, 'owner');
			expect(workspace?.user.name).toBe('Integration Owner');
			expect(workspace?.contacts.some((row) => row.id === contactId)).toBe(true);
			expect(typeof workspace?.gifts.find((row) => row.id === giftId)?.amountMinor).toBe('number');
			const volunteerWorkspace = await workspaceFromPostgres(slug, volunteerId, 'volunteer');
			const privateTask = volunteerWorkspace?.tasks.find((row) => row.id === taskId);
			expect(privateTask).not.toHaveProperty('contactEmail');
			expect(privateTask).not.toHaveProperty('privateNotes');
			expect(privateTask?.profile).toEqual({});
			expect(volunteerWorkspace?.gifts.find((row) => row.id === giftId)).not.toHaveProperty(
				'contactId'
			);
			await expect(
				mutatePostgres(
					slug,
					marketerId,
					'gifts',
					{ amountMinor: 100, currency: 'USD', kind: 'one_time', status: 'recorded' },
					'create'
				)
			).rejects.toMatchObject({ status: 403 });
			await expect(
				mutatePostgres(
					slug,
					account.userId,
					'tasks',
					{ title: 'Bad reference', contactId: randomUUID() },
					'create'
				)
			).rejects.toMatchObject({ status: 422 });
			const target = await mutatePostgres(
				slug,
				account.userId,
				'contacts',
				{ name: 'Canonical Contact', email: `target-${suffix}@example.test` },
				'create'
			);
			const targetId = String((target as Record<string, unknown>).id);
			const preview = await previewPostgresContactMerge(slug, account.userId, contactId, targetId);
			expect(preview.referenceCounts.tasks).toBe(1);
			const merge = await mergePostgresContacts(slug, account.userId, contactId, targetId);
			const mergedWorkspace = await workspaceFromPostgres(slug, account.userId, 'owner');
			expect(
				mergedWorkspace?.contactAliases?.some(
					(alias) => alias.id === contactId && alias.mergedInto === targetId
				)
			).toBe(true);
			expect(mergedWorkspace?.tasks.find((row) => row.id === taskId)?.contactId).toBe(targetId);
			await undoPostgresContactMerge(slug, account.userId, merge.mergeId);
			const restoredWorkspace = await workspaceFromPostgres(slug, account.userId, 'owner');
			expect(restoredWorkspace?.contacts.some((row) => row.id === contactId)).toBe(true);
			expect(restoredWorkspace?.tasks.find((row) => row.id === taskId)?.contactId).toBe(contactId);
			const source2 = await mutatePostgres(
				slug,
				account.userId,
				'contacts',
				{ name: 'Merge Source Two', email: `source2-${suffix}@example.test` },
				'create'
			);
			const target2 = await mutatePostgres(
				slug,
				account.userId,
				'contacts',
				{ name: 'Merge Target Two', email: `target2-${suffix}@example.test` },
				'create'
			);
			const source2Id = String((source2 as Record<string, unknown>).id),
				target2Id = String((target2 as Record<string, unknown>).id);
			const draft = await mutatePostgres(
				slug,
				account.userId,
				'emails',
				{ contactId: source2Id, subject: 'Original draft', body: 'Draft' },
				'create'
			);
			const emailId = String((draft as Record<string, unknown>).id);
			const merge2 = await mergePostgresContacts(slug, account.userId, source2Id, target2Id);
			await mutatePostgres(
				slug,
				account.userId,
				'emails',
				{ id: emailId, contactId: target2Id, subject: 'Edited after merge' },
				'update'
			);
			await expect(
				undoPostgresContactMerge(slug, account.userId, merge2.mergeId)
			).rejects.toMatchObject({ status: 409 });
			const source3 = await mutatePostgres(
				slug,
				account.userId,
				'contacts',
				{ name: 'Merge Source Three', email: `source3-${suffix}@example.test` },
				'create'
			);
			const target3 = await mutatePostgres(
				slug,
				account.userId,
				'contacts',
				{ name: 'Merge Target Three', email: `target3-${suffix}@example.test` },
				'create'
			);
			const source3Id = String((source3 as Record<string, unknown>).id),
				target3Id = String((target3 as Record<string, unknown>).id);
			const merge3 = await mergePostgresContacts(slug, account.userId, source3Id, target3Id);
			await mutatePostgres(
				slug,
				account.userId,
				'contacts',
				{ id: target3Id, name: 'Edited after merge' },
				'update'
			);
			await expect(
				undoPostgresContactMerge(slug, account.userId, merge3.mergeId)
			).rejects.toMatchObject({ status: 409 });
			const source4 = await mutatePostgres(
				slug,
				account.userId,
				'contacts',
				{ name: 'Email Source', email: `transfer-${suffix}@example.test` },
				'create'
			);
			const target4 = await mutatePostgres(
				slug,
				account.userId,
				'contacts',
				{ name: 'Email Target' },
				'create'
			);
			const source4Id = String((source4 as Record<string, unknown>).id),
				target4Id = String((target4 as Record<string, unknown>).id);
			const merge4 = await mergePostgresContacts(slug, account.userId, source4Id, target4Id);
			const afterEmailMerge = await workspaceFromPostgres(slug, account.userId, 'owner');
			expect(afterEmailMerge?.contacts.find((row) => row.id === target4Id)?.email).toBe(
				`transfer-${suffix}@example.test`
			);
			await undoPostgresContactMerge(slug, account.userId, merge4.mergeId);
			const afterEmailUndo = await workspaceFromPostgres(slug, account.userId, 'owner');
			expect(afterEmailUndo?.contacts.find((row) => row.id === source4Id)?.email).toBe(
				`transfer-${suffix}@example.test`
			);
		}
	);
});

afterAll(async () => {
	if (enabled) await getPool().end();
});
