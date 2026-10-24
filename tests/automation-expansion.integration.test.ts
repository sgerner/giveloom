import { afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createOwnerAccount, getPool, mutatePostgres } from '../src/lib/server/database';
import {
	createAutomation,
	decideAutomationApproval,
	generateAutomationApprovalDraft,
	handleAutomationStepOutboxEvent,
	listAutomationApprovals,
	publishAutomation,
	simulateAutomation,
	startManualAutomation
} from '../src/lib/server/automation';
import { workflowDraftContact } from '../src/lib/server/communications';
import { saveIntegration } from '../src/lib/server/integrations';
import { updateAssistantSettings } from '../src/lib/server/ai-assistant';

const enabled =
	Boolean(process.env.DATABASE_URL) && process.env.RUN_POSTGRES_MUTATION_TESTS === 'true';
const withTenant = async <T>(
	tenantId: string,
	fn: (client: import('pg').PoolClient) => Promise<T>
) => {
	const client = await getPool().connect();
	try {
		await client.query('BEGIN');
		await client.query("SELECT set_config('app.tenant_id',$1,true)", [tenantId]);
		const result = await fn(client);
		await client.query('COMMIT');
		return result;
	} catch (error) {
		await client.query('ROLLBACK');
		throw error;
	} finally {
		client.release();
	}
};
const owner = async () => {
	const slug = `automation-${randomUUID().replaceAll('-', '').slice(0, 12)}`;
	const account = await createOwnerAccount({
		email: `${slug}@example.test`,
		name: 'Automation Owner',
		passwordHash: 'fixture',
		organizationName: 'Automation Expansion Tests',
		slug,
		sessionExpiresAt: new Date(Date.now() + 3600000),
		testOnlyVerifiedFixture: true
	});
	return {
		session: { userId: account.userId, tenantSlug: slug, role: 'owner', demo: false },
		tenantId: account.tenantId,
		slug
	};
};
afterAll(async () => {
	if (enabled) await getPool().end();
});

describe('automation expansion database workflows', () => {
	it.skipIf(!enabled)(
		'simulates conditions against current tenant segment membership',
		async () => {
			const account = await owner();
			const contact = (await mutatePostgres(
				account.slug,
				account.session.userId,
				'contacts',
				{ name: 'Segment Donor', email: `segment-${randomUUID().slice(0, 8)}@example.test` },
				'create'
			)) as { id: string };
			const segmentId = randomUUID();
			await withTenant(account.tenantId, async (client) => {
				await client.query(
					"INSERT INTO workspace_records(tenant_id,id,resource,data) VALUES($1,$2,'segments',$3)",
					[
						account.tenantId,
						segmentId,
						{ name: 'New contacts', rules: [{ field: 'stage', operator: 'equals', value: 'new' }] }
					]
				);
			});
			const created = await createAutomation(account.session, {
				name: 'Segment condition',
				definition: {
					trigger: { type: 'manual' },
					startId: 'check',
					nodes: [
						{
							id: 'check',
							type: 'condition',
							field: 'contact.segmentIds',
							operator: 'contains',
							value: segmentId,
							whenTrue: 'yes',
							whenFalse: 'no'
						},
						{ id: 'yes', type: 'exit' },
						{ id: 'no', type: 'exit' }
					]
				}
			});
			const result = await simulateAutomation(
				account.session,
				created.automation.id as string,
				contact.id
			);
			expect(result.steps[0]?.outcome).toContain('is true');
			expect(result.steps[1]?.nodeId).toBe('yes');
		}
	);

	it.skipIf(!enabled)(
		'freezes an approval-required workflow email to one contact and never sends it',
		async () => {
			const account = await owner();
			const contact = (await mutatePostgres(
				account.slug,
				account.session.userId,
				'contacts',
				{ name: 'Workflow Donor', email: `donor-${randomUUID().slice(0, 8)}@example.test` },
				'create'
			)) as { id: string };
			const created = await createAutomation(account.session, {
				name: 'Thank a donor',
				definition: {
					trigger: { type: 'manual' },
					startId: 'email',
					frequencyCapHours: 0,
					nodes: [
						{
							id: 'email',
							type: 'action',
							action: 'email',
							subject: 'Thank you',
							body: 'A personal note.',
							next: 'done'
						},
						{ id: 'done', type: 'exit' }
					]
				}
			});
			const workflowId = created.automation.id as string;
			await publishAutomation(account.session, workflowId);
			const run = await startManualAutomation(account.session, workflowId, contact.id);
			expect(run.status).toBe('queued');
			const event = await withTenant(
				account.tenantId,
				async (client) =>
					(
						await client.query(
							'SELECT id,event_type AS "eventType",tenant_id AS "tenantId",payload FROM outbox_events WHERE tenant_id=$1 AND event_type=\'automation.step\' AND payload->>\'runId\'=$2',
							[account.tenantId, run.runId]
						)
					).rows[0]
			);
			await handleAutomationStepOutboxEvent(event, getPool());
			const pending = await listAutomationApprovals(account.session);
			expect(pending.approvals).toHaveLength(1);
			expect(pending.approvals[0]).toMatchObject({
				contactId: contact.id,
				status: 'pending',
				content: { subject: 'Thank you', body: 'A personal note.' }
			});
			const decision = await decideAutomationApproval(
				account.session,
				pending.approvals[0].id,
				true
			);
			expect(decision).toMatchObject({ status: 'approved', sendStatus: 'not_sent' });
			if (!decision.draftId) throw new Error('Approved workflow draft was not created.');
			const draftId = decision.draftId;
			const draft = await withTenant(
				account.tenantId,
				async (client) =>
					(
						await client.query(
							"SELECT data FROM workspace_records WHERE tenant_id=$1 AND resource='emails' AND id=$2",
							[account.tenantId, draftId]
						)
					).rows[0].data
			);
			expect(draft).toMatchObject({
				contactId: contact.id,
				workflowApprovalId: pending.approvals[0].id,
				status: 'draft',
				approved: false
			});
			const boundContact = await withTenant(account.tenantId, async (client) => {
				await client.query(
					"UPDATE workspace_records SET data=data-'workflowApprovalId'-'contactId' WHERE tenant_id=$1 AND resource='emails' AND id=$2",
					[account.tenantId, draftId]
				);
				return workflowDraftContact(client, account.tenantId, draftId);
			});
			expect(boundContact).toBe(contact.id);
			await expect(
				decideAutomationApproval(account.session, pending.approvals[0].id, true)
			).rejects.toMatchObject({ status: 409 });
		}
	);

	it.skipIf(!enabled)(
		'generates an AI-assisted workflow draft with tenant budget tracking and no send side effect',
		async () => {
			process.env.CREDENTIAL_VAULT_KEY ||= Buffer.alloc(32, 31).toString('base64');
			process.env.CREDENTIAL_VAULT_KEY_ID ||= 'primary';
			const account = await owner();
			const contact = (await mutatePostgres(
				account.slug,
				account.session.userId,
				'contacts',
				{ name: 'Morgan Steward', email: `morgan-${randomUUID().slice(0, 8)}@example.test` },
				'create'
			)) as { id: string };
			await saveIntegration(
				account.session,
				'openai',
				{ apiKey: 'fake-api-key-not-a-real-provider-secret', model: 'gpt-fake-model' },
				true
			);
			await updateAssistantSettings(account.session, {
				enabled: true,
				inputUsdPerMillion: 0.000001,
				outputUsdPerMillion: 0.000002,
				requestsPerDay: 20,
				tokensPerDay: 100000,
				costMicroUsdPerDay: 2_000_000,
				maxOutputTokens: 400
			});
			const created = await createAutomation(account.session, {
				name: 'AI thank you',
				definition: {
					trigger: { type: 'manual' },
					startId: 'draft',
					nodes: [
						{
							id: 'draft',
							type: 'action',
							action: 'ai_draft',
							subject: 'Thank you',
							body: 'Thank them for supporting our community program.',
							next: 'done'
						},
						{ id: 'done', type: 'exit' }
					]
				}
			});
			await publishAutomation(account.session, created.automation.id as string);
			const run = await startManualAutomation(
				account.session,
				created.automation.id as string,
				contact.id
			);
			const event = await withTenant(
				account.tenantId,
				async (client) =>
					(
						await client.query(
							'SELECT id,event_type AS "eventType",tenant_id AS "tenantId",payload FROM outbox_events WHERE tenant_id=$1 AND event_type=\'automation.step\' AND payload->>\'runId\'=$2',
							[account.tenantId, run.runId]
						)
					).rows[0]
			);
			await handleAutomationStepOutboxEvent(event, getPool());
			const approval = (await listAutomationApprovals(account.session)).approvals[0];
			let requestBody: Record<string, unknown> | undefined;
			const generated = await generateAutomationApprovalDraft(
				account.session,
				approval.id,
				getPool(),
				{
					fetcher: async (_input, init) => {
						requestBody = JSON.parse(String(init?.body));
						return Response.json({
							status: 'completed',
							model: 'gpt-fake-model',
							output_text: JSON.stringify({
								answer: 'Dear Morgan, thank you for supporting our community program.',
								toolCalls: [],
								proposedAction: null
							}),
							usage: { input_tokens: 40, output_tokens: 12 }
						});
					}
				}
			);
			expect(generated).toMatchObject({
				status: 'pending',
				generated: true,
				content: {
					body: 'Dear Morgan, thank you for supporting our community program.',
					aiGenerated: true
				}
			});
			expect(requestBody).toMatchObject({ model: 'gpt-fake-model', store: false });
			expect(JSON.stringify(requestBody?.input)).toContain('Morgan Steward');
			expect(JSON.stringify(requestBody?.input)).toContain(
				'Thank them for supporting our community program.'
			);
			const usage = await withTenant(
				account.tenantId,
				async (client) =>
					(
						await client.query(
							'SELECT provider,model,status,input_tokens,output_tokens FROM ai_usage WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 1',
							[account.tenantId]
						)
					).rows[0]
			);
			expect(usage).toMatchObject({
				provider: 'openai',
				model: 'gpt-fake-model',
				status: 'succeeded',
				input_tokens: 40,
				output_tokens: 12
			});
			const decision = await decideAutomationApproval(account.session, approval.id, true);
			expect(decision).toMatchObject({ status: 'approved', sendStatus: 'not_sent' });
			if (!decision.draftId) throw new Error('AI-approved workflow draft was not created.');
			const draft = await withTenant(
				account.tenantId,
				async (client) =>
					(
						await client.query(
							"SELECT data FROM workspace_records WHERE tenant_id=$1 AND resource='emails' AND id=$2",
							[account.tenantId, decision.draftId]
						)
					).rows[0].data
			);
			expect(draft).toMatchObject({
				contactId: contact.id,
				body: 'Dear Morgan, thank you for supporting our community program.',
				aiAssisted: true,
				approved: false
			});
		}
	);
});
