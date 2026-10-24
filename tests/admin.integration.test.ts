import { afterAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { createOwnerAccount, getPool, mutatePostgres } from '../src/lib/server/database';
import {
	authenticateApiToken,
	createApiToken,
	listApiTokens,
	revokeApiToken,
	resolveApiSession
} from '../src/lib/server/api-tokens';
import {
	getPlatformHealth,
	dispatchWebhookSubscriptions,
	ipIsPublic,
	listPlatformTenants,
	runTenantRetentionMaintenance,
	setRetentionPolicy,
	validateWebhookTarget
} from '../src/lib/server/admin';
import { tenantTransaction } from '../src/lib/server/tenant-service';

const enabled = !!process.env.DATABASE_URL && process.env.RUN_POSTGRES_MUTATION_TESTS === 'true';
if (enabled) {
	process.env.CREDENTIAL_VAULT_KEY ||= randomBytes(32).toString('base64');
	process.env.CREDENTIAL_VAULT_KEY_ID ||= 'primary';
}
afterAll(async () => {
	if (enabled) await getPool().end();
});
async function fixture(prefix: string) {
	const suffix = crypto.randomUUID().slice(0, 8),
		slug = `${prefix}-${suffix}`,
		email = `${slug}@example.test`;
	const account = await createOwnerAccount({
		email,
		name: 'Admin Fixture',
		passwordHash: 'fixture',
		organizationName: 'Admin Test Org',
		slug,
		sessionExpiresAt: new Date(Date.now() + 3_600_000),
		testOnlyVerifiedFixture: true
	});
	return {
		tenantId: account.tenantId,
		email,
		session: { userId: account.userId, tenantSlug: slug, role: 'owner', demo: false }
	};
}

describe('administration and scoped integrations', () => {
	it('rejects private network webhook targets, DNS rebinding, and non-HTTPS URLs', async () => {
		expect(ipIsPublic('127.0.0.1')).toBe(false);
		expect(ipIsPublic('10.2.3.4')).toBe(false);
		expect(ipIsPublic('169.254.2.5')).toBe(false);
		expect(ipIsPublic('192.88.99.1')).toBe(false);
		expect(ipIsPublic('8.8.8.8')).toBe(true);
		expect(ipIsPublic('2606:4700:4700::1111')).toBe(true);
		expect(ipIsPublic('2001:2::1')).toBe(false);
		expect(ipIsPublic('2001:0002:0000:0000:0000:0000:0000:0001')).toBe(false);
		expect(ipIsPublic('3fff::1')).toBe(false);
		expect(ipIsPublic('3fff:0fff:ffff:ffff:ffff:ffff:ffff:ffff')).toBe(false);
		expect(ipIsPublic('2001:db8::1')).toBe(false);
		expect(ipIsPublic('2001:0db8:0000:0000:0000:0000:0000:0001')).toBe(false);
		expect(ipIsPublic('2001:5::1')).toBe(false);
		expect(ipIsPublic('2001:1::123')).toBe(false);
		expect(ipIsPublic('2001:0001:0000:0000:0000:0000:0000:0001')).toBe(true);
		expect(ipIsPublic('2001:1::2')).toBe(true);
		expect(ipIsPublic('2001:1::3')).toBe(true);
		expect(ipIsPublic('2001:3::1')).toBe(true);
		expect(ipIsPublic('2001:4:112::1')).toBe(true);
		expect(ipIsPublic('2001:20::1')).toBe(true);
		expect(ipIsPublic('2001:2f:ffff::1')).toBe(true);
		expect(ipIsPublic('2001:1f:ffff::1')).toBe(false);
		expect(ipIsPublic('2001:30::1')).toBe(true);
		expect(ipIsPublic('2001:3f:ffff::1')).toBe(true);
		expect(ipIsPublic('2001:40::1')).toBe(false);
		expect(ipIsPublic('::ffff:192.168.1.1')).toBe(false);
		expect(ipIsPublic('::ffff:8.8.8.8')).toBe(true);
		await expect(validateWebhookTarget('http://hooks.example.org')).rejects.toMatchObject({
			status: 422
		});
		await expect(validateWebhookTarget('https://127.0.0.1')).rejects.toMatchObject({ status: 422 });
		await expect(
			validateWebhookTarget('https://public.example.org', async () => [
				{ address: '192.168.1.4', family: 4 }
			])
		).rejects.toMatchObject({ status: 422 });
		await expect(
			validateWebhookTarget('https://public.example.org', async () => [
				{ address: '8.8.8.8', family: 4 },
				{ address: '10.0.0.5', family: 4 }
			])
		).rejects.toMatchObject({ status: 422 });
		await expect(
			validateWebhookTarget('https://public.example.org', async () => [
				{ address: '8.8.8.8', family: 4 }
			])
		).resolves.toMatchObject({ address: '8.8.8.8' });
	});

	it.skipIf(!enabled)(
		'restricts automation webhook actions to their single validated endpoint',
		async () => {
			const account = await fixture('automation-webhook-endpoint');
			const first = crypto.randomUUID(),
				other = crypto.randomUUID();
			await tenantTransaction(account.session, null, async (client, tenant) => {
				for (const id of [first, other])
					await client.query(
						"INSERT INTO webhook_endpoints(tenant_id,id,label,target_url,secret_envelope,events,approved_by,approved_at,created_by) VALUES($1,$2,'Workflow endpoint','https://example.org','opaque',ARRAY['automation.action'],$3,now(),$3)",
						[tenant.id, id, account.session.userId]
					);
			});
			const eventId = crypto.randomUUID();
			await dispatchWebhookSubscriptions(
				{
					id: eventId,
					tenantId: account.tenantId,
					eventType: 'automation.action',
					payload: { endpointId: first, resource: 'automation_runs', recordId: crypto.randomUUID() }
				},
				getPool()
			);
			await tenantTransaction(account.session, null, async (client, tenant) => {
				const rows = await client.query(
					'SELECT endpoint_id AS "endpointId",event_payload AS payload FROM webhook_deliveries WHERE tenant_id=$1 AND event_type=\'automation.action\'',
					[tenant.id]
				);
				expect(rows.rows).toHaveLength(1);
				expect(rows.rows[0]).toMatchObject({
					endpointId: first,
					payload: { endpointId: first, type: 'automation.action' }
				});
			});
			await dispatchWebhookSubscriptions(
				{
					id: crypto.randomUUID(),
					tenantId: account.tenantId,
					eventType: 'automation.action',
					payload: { recordId: crypto.randomUUID() }
				},
				getPool()
			);
			await tenantTransaction(account.session, null, async (client, tenant) =>
				expect(
					(
						await client.query(
							"SELECT 1 FROM webhook_deliveries WHERE tenant_id=$1 AND event_type='automation.action'",
							[tenant.id]
						)
					).rowCount
				).toBe(1)
			);
		}
	);

	it.skipIf(!enabled)(
		'creates hashed tenant-bound API tokens with enforced scopes, rate limits, revocation, and role checks',
		async () => {
			const a = await fixture('admin-token-a'),
				b = await fixture('admin-token-b');
			const contact = (await mutatePostgres(
				a.session.tenantSlug,
				a.session.userId,
				'contacts',
				{ name: 'Tenant A Contact', email: `a-${crypto.randomUUID()}@example.test` },
				'create'
			)) as { id: string };
			await mutatePostgres(
				b.session.tenantSlug,
				b.session.userId,
				'contacts',
				{ name: 'Tenant B Contact', email: `b-${crypto.randomUUID()}@example.test` },
				'create'
			);
			const created = await createApiToken(a.session, {
				label: 'Read contacts',
				permissions: ['contacts:read']
			});
			expect(created.token).toMatch(/^gl_pat_/);
			expect(created.item.tokenPrefix).toBe(created.token.slice(0, 15));
			const listed = await listApiTokens(a.session);
			expect(listed.tokens[0]).not.toHaveProperty('tokenHash');
			expect(listed.tokens[0]).not.toHaveProperty('token');
			const request = new Request('https://giveloom.example/api/v1/contacts', {
				headers: { authorization: `Bearer ${created.token}` }
			});
			const authorized = await resolveApiSession(request, null, 'contacts:read');
			expect(authorized.tenantSlug).toBe(a.session.tenantSlug);
			await expect(authenticateApiToken(created.token, 'giving:read')).rejects.toMatchObject({
				status: 403
			});
			expect(await listApiTokens(b.session)).toMatchObject({ tokens: [] });
			await expect(revokeApiToken(b.session, created.item.id)).rejects.toMatchObject({
				status: 404
			});
			await tenantTransaction(a.session, null, async (client, tenant) => {
				await client.query(
					"UPDATE memberships SET role='fundraiser' WHERE tenant_id=$1 AND user_id=$2",
					[tenant.id, a.session.userId]
				);
			});
			await expect(listApiTokens(a.session)).rejects.toMatchObject({ status: 403 });
			await tenantTransaction(a.session, null, async (client, tenant) => {
				await client.query(
					"UPDATE memberships SET role='owner' WHERE tenant_id=$1 AND user_id=$2",
					[tenant.id, a.session.userId]
				);
			});
			await expect(revokeApiToken(a.session, created.item.id)).resolves.toMatchObject({
				revoked: true
			});
			await expect(authenticateApiToken(created.token, 'contacts:read')).rejects.toMatchObject({
				status: 401
			});
			await expect(
				createApiToken(b.session, { label: 'No write permission', permissions: ['giving:write'] })
			).resolves.toHaveProperty('item');
			await tenantTransaction(b.session, null, async (client, tenant) => {
				await client.query(
					"UPDATE memberships SET role='fundraiser' WHERE tenant_id=$1 AND user_id=$2",
					[tenant.id, b.session.userId]
				);
			});
			await expect(
				createApiToken(b.session, { label: 'Blocked', permissions: ['contacts:read'] })
			).rejects.toMatchObject({ status: 403 });
			expect(contact.id).toBeTruthy();
		}
	);

	it.skipIf(!enabled)(
		'keeps platform aggregate access behind the configured operator allowlist',
		async () => {
			const operator = await fixture('platform-operator'),
				ordinary = await fixture('platform-ordinary');
			const previous = process.env.PLATFORM_ADMIN_EMAILS;
			try {
				process.env.PLATFORM_ADMIN_EMAILS = operator.email;
				const result = await getPlatformHealth(operator.session);
				expect(result.tenantCount).toBeGreaterThanOrEqual(2);
				expect(result).not.toHaveProperty('contacts');
				expect(
					(await listPlatformTenants(operator.session)).some(
						(tenant) => tenant.slug === operator.session.tenantSlug
					)
				).toBe(true);
				await expect(getPlatformHealth(ordinary.session)).rejects.toMatchObject({ status: 403 });
			} finally {
				if (previous === undefined) delete process.env.PLATFORM_ADMIN_EMAILS;
				else process.env.PLATFORM_ADMIN_EMAILS = previous;
			}
		}
	);

	it.skipIf(!enabled)(
		'runs retention cleanup only when opted in and keeps expired financial or donor records out of scope',
		async () => {
			const a = await fixture('admin-retention');
			await setRetentionPolicy(a.session, {
				enabled: false,
				aiRetentionDays: 30,
				webhookDeliveryRetentionDays: 90
			});
			expect(await runTenantRetentionMaintenance(getPool(), a.tenantId)).toMatchObject({
				ran: false
			});
			await tenantTransaction(a.session, null, async (client, tenant) => {
				const conversation = crypto.randomUUID();
				await client.query(
					"INSERT INTO ai_conversations(tenant_id,id,user_id,title,created_at,updated_at,retention_until) VALUES($1,$2,$3,'Old conversation',now()-interval '2 years',now()-interval '2 years',now()-interval '2 years')",
					[tenant.id, conversation, a.session.userId]
				);
				await client.query(
					"INSERT INTO ai_messages(tenant_id,conversation_id,user_id,role,content_redacted,content_hash,created_at,retention_until) VALUES($1,$2,$3,'user','old redacted text',$4,now()-interval '2 years',now()-interval '2 years')",
					[tenant.id, conversation, a.session.userId, 'a'.repeat(64)]
				);
				await client.query(
					"INSERT INTO ai_tool_audit(tenant_id,user_id,conversation_id,tool_name,execution_kind,arguments_hash,created_at,retention_until) VALUES($1,$2,$3,'search','read',$4,now()-interval '2 years',now()-interval '2 years')",
					[tenant.id, a.session.userId, conversation, 'b'.repeat(64)]
				);
				const endpoint = crypto.randomUUID();
				await client.query(
					"INSERT INTO webhook_endpoints(tenant_id,id,label,target_url,secret_envelope,events,approved_by,approved_at,created_by) VALUES($1,$2,'Endpoint','https://example.org','opaque',ARRAY['contacts.created'],$3,now(),$3)",
					[tenant.id, endpoint, a.session.userId]
				);
				await client.query(
					"INSERT INTO webhook_deliveries(tenant_id,endpoint_id,event_type,event_payload,status,created_at) VALUES($1,$2,'contacts.created',$3,'delivered',now()-interval '2 years')",
					[tenant.id, endpoint, { eventId: crypto.randomUUID() }]
				);
			});
			await setRetentionPolicy(a.session, {
				enabled: true,
				aiRetentionDays: 30,
				webhookDeliveryRetentionDays: 90
			});
			expect(await runTenantRetentionMaintenance(getPool(), a.tenantId)).toMatchObject({
				ran: true
			});
			await tenantTransaction(a.session, null, async (client, tenant) => {
				expect(
					(await client.query('SELECT 1 FROM ai_conversations WHERE tenant_id=$1', [tenant.id]))
						.rowCount
				).toBe(0);
				expect(
					(await client.query('SELECT 1 FROM ai_messages WHERE tenant_id=$1', [tenant.id])).rowCount
				).toBe(0);
				expect(
					(await client.query('SELECT 1 FROM webhook_deliveries WHERE tenant_id=$1', [tenant.id]))
						.rowCount
				).toBe(0);
			});
		}
	);
});
