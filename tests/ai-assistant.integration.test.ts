import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createOwnerAccount, getPool, mutatePostgres } from '../src/lib/server/database';
import { saveIntegration } from '../src/lib/server/integrations';
import {
	generateWorkflowEmailDraft,
	setAssistantUserLimit,
	updateAssistantSettings
} from '../src/lib/server/ai-assistant';
import { POST as execute } from '../src/routes/api/v1/ai/execute/+server';
import { POST as confirm } from '../src/routes/api/v1/ai/confirm/+server';

const enabled =
	Boolean(process.env.DATABASE_URL) && process.env.RUN_POSTGRES_MUTATION_TESTS === 'true';
const describeDb = enabled ? describe : describe.skip;

function responseFor(value: Record<string, unknown>): Response {
	return new Response(
		JSON.stringify({
			status: 'completed',
			model: 'gpt-fake-model',
			output_text: JSON.stringify(value),
			usage: { input_tokens: 91, output_tokens: 26 }
		}),
		{ status: 200, headers: { 'content-type': 'application/json' } }
	);
}
function fakeTransport(
	value: Record<string, unknown>,
	seen: Array<{ url: string; body: Record<string, unknown>; authorization: string }>
): typeof fetch {
	return async (input, init) => {
		const headers = new Headers(init?.headers);
		seen.push({
			url: String(input),
			body: JSON.parse(String(init?.body)) as Record<string, unknown>,
			authorization: headers.get('authorization') ?? ''
		});
		return responseFor(value);
	};
}

describeDb('AI assistant provider/API and confirmation integration', () => {
	let owner: Awaited<ReturnType<typeof createOwnerAccount>>;
	let otherTenant: Awaited<ReturnType<typeof createOwnerAccount>>;
	let session: { userId: string; tenantSlug: string; role: string; demo: boolean };
	let analystSession: { userId: string; tenantSlug: string; role: string; demo: boolean };
	let contactId = '';
	const seen: Array<{ url: string; body: Record<string, unknown>; authorization: string }> = [];
	const assistantSession = (
		account: Awaited<ReturnType<typeof createOwnerAccount>>,
		role: string
	) => ({ userId: account.userId, tenantSlug: account.tenant.slug, role, demo: false });
	const event = (
		account: Awaited<ReturnType<typeof createOwnerAccount>>,
		role: string,
		body: unknown,
		path = '/api/v1/ai/execute'
	) =>
		({
			locals: { session: assistantSession(account, role) },
			request: new Request(`http://localhost${path}`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body)
			})
		}) as never;
	const baseAnswer = {
		answer: 'I checked the tenant workspace.',
		toolCalls: [{ name: 'list_campaigns', argumentsJson: '{}' }],
		proposedAction: null
	};

	beforeAll(async () => {
		process.env.CREDENTIAL_VAULT_KEY = Buffer.alloc(32, 19).toString('base64');
		const suffix = randomUUID().slice(0, 8);
		owner = await createOwnerAccount({
			email: `ai-owner-${suffix}@example.test`,
			name: 'AI Owner',
			passwordHash: 'fixture-hash',
			organizationName: 'Assistant Test',
			slug: `assistant-test-${suffix}`,
			testOnlyVerifiedFixture: true
		});
		otherTenant = await createOwnerAccount({
			email: `ai-other-${suffix}@example.test`,
			name: 'Other Tenant',
			passwordHash: 'fixture-hash',
			organizationName: 'Other Tenant',
			slug: `assistant-other-${suffix}`,
			testOnlyVerifiedFixture: true
		});
		session = assistantSession(owner, 'owner');
		await saveIntegration(
			session,
			'openai',
			{ apiKey: 'fake-api-key-not-a-real-provider-secret', model: 'gpt-fake-model' },
			true
		);
		await updateAssistantSettings(session, {
			enabled: true,
			inputUsdPerMillion: 0.000001,
			outputUsdPerMillion: 0.000002,
			requestsPerDay: 20,
			tokensPerDay: 100000,
			costMicroUsdPerDay: 2_000_000,
			maxOutputTokens: 400
		});
		const client = await getPool().connect();
		try {
			await client.query('BEGIN');
			await client.query("SELECT set_config('app.tenant_id',$1,true)", [owner.tenant.id]);
			await client.query(
				"INSERT INTO memberships(tenant_id,user_id,role,status) VALUES($1,$2,'analyst','active')",
				[owner.tenant.id, otherTenant.userId]
			);
			await client.query('COMMIT');
		} catch (error) {
			await client.query('ROLLBACK');
			throw error;
		} finally {
			client.release();
		}
		analystSession = {
			userId: otherTenant.userId,
			tenantSlug: owner.tenant.slug,
			role: 'analyst',
			demo: false
		};
	});

	it('runs a real Responses API request through an explicit fake transport and returns safe read results', async () => {
		const result = await execute(event(owner, 'owner', { message: 'Review our campaigns.' }), {
			fetcher: fakeTransport(baseAnswer, seen)
		});
		expect(result.status).toBe(200);
		const body = await result.json();
		expect(body.answer).toBe('I checked the tenant workspace.');
		expect(body.tools[0].tool).toBe('list_campaigns');
		expect(body.usage).toMatchObject({
			model: 'gpt-fake-model',
			inputTokens: 91,
			outputTokens: 26
		});
		expect(seen).toHaveLength(1);
		expect(seen[0].url).toBe('https://api.openai.com/v1/responses');
		expect(seen[0].authorization).toBe('Bearer fake-api-key-not-a-real-provider-secret');
		expect(seen[0].body).toMatchObject({
			model: 'gpt-fake-model',
			store: false,
			text: { format: { type: 'json_schema', strict: true } }
		});
		const history = await (
			await import('../src/lib/server/ai-assistant')
		).listConversations(session);
		const latest = history.conversations[0] as { messages: Array<{ content: string }> };
		expect(latest.messages.map((message) => message.content).join(' ')).not.toContain(
			'Review our campaigns.'
		);
		expect(latest.messages[0].content).toContain('redacted');
	});

	it('generates only a plain-text workflow draft body through the budgeted provider path', async () => {
		const answer = {
			answer:
				'Dear Morgan, thank you for supporting our community programs. We are grateful for your generosity.',
			toolCalls: [],
			proposedAction: null
		};
		const generated = await generateWorkflowEmailDraft(
			session,
			{
				contactName: 'Morgan Donor',
				instructions:
					'Write a brief thank-you for supporting community programs. Do not include a gift amount.'
			},
			{ fetcher: fakeTransport(answer, seen) }
		);
		expect(generated.body).toBe(answer.answer);
		const input = JSON.parse(String(seen.at(-1)?.body.input)) as {
			contactName: string;
			instructions: string;
		};
		expect(input).toEqual({
			contactName: 'Morgan Donor',
			instructions:
				'Write a brief thank-you for supporting community programs. Do not include a gift amount.'
		});
		expect(seen.at(-1)?.body.store).toBe(false);
	});

	it('shows an exact contact-create preview and requires one-use tenant-bound confirmation', async () => {
		const proposal = {
			answer: 'I can prepare that contact.',
			toolCalls: [],
			proposedAction: {
				title: 'Create a contact',
				resource: 'contacts',
				action: 'create',
				dataJson: JSON.stringify({
					name: 'Assistant Created',
					email: 'new-contact@example.test',
					stage: 'new',
					tags: ['assistant']
				})
			}
		};
		const previewResponse = await execute(
			event(owner, 'owner', { message: 'Create the contact.' }),
			{ fetcher: fakeTransport(proposal, seen) }
		);
		expect(previewResponse.status).toBe(200);
		const preview = (await previewResponse.json()).proposals[0] as {
			id: string;
			confirmationToken: string;
			preview: { data: Record<string, unknown> };
		};
		expect(preview.preview.data).toMatchObject({
			name: 'Assistant Created',
			email: 'new-contact@example.test'
		});
		const foreign = await confirm(
			event(
				otherTenant,
				'owner',
				{ proposalId: preview.id, confirmationToken: preview.confirmationToken },
				'/api/v1/ai/confirm'
			)
		);
		expect(foreign.status).toBe(404);
		const applied = await confirm(
			event(
				owner,
				'owner',
				{ proposalId: preview.id, confirmationToken: preview.confirmationToken },
				'/api/v1/ai/confirm'
			)
		);
		expect(applied.status).toBe(200);
		expect((await applied.json()).item).toMatchObject({ name: 'Assistant Created' });
		const replay = await confirm(
			event(
				owner,
				'owner',
				{ proposalId: preview.id, confirmationToken: preview.confirmationToken },
				'/api/v1/ai/confirm'
			)
		);
		expect(replay.status).toBe(409);
	});

	it('rejects stale update previews without overwriting a newer CRM change', async () => {
		contactId = randomUUID();
		await mutatePostgres(
			owner.tenant.slug,
			owner.userId,
			'contacts',
			{ id: contactId, name: 'Snapshot Contact', email: 'snapshot@example.test', stage: 'new' },
			'create'
		);
		const proposal = {
			answer: 'I can update this contact.',
			toolCalls: [],
			proposedAction: {
				title: 'Update the contact',
				resource: 'contacts',
				action: 'update',
				dataJson: JSON.stringify({ id: contactId, stage: 'major' })
			}
		};
		const previewResponse = await execute(
			event(owner, 'owner', { message: 'Mark the contact major.' }),
			{ fetcher: fakeTransport(proposal, seen) }
		);
		const preview = (await previewResponse.json()).proposals[0] as {
			id: string;
			confirmationToken: string;
		};
		await mutatePostgres(
			owner.tenant.slug,
			owner.userId,
			'contacts',
			{
				id: contactId,
				name: 'Snapshot Contact',
				email: 'snapshot@example.test',
				stage: 'leadership'
			},
			'update'
		);
		const applied = await confirm(
			event(
				owner,
				'owner',
				{ proposalId: preview.id, confirmationToken: preview.confirmationToken },
				'/api/v1/ai/confirm'
			)
		);
		expect(applied.status).toBe(409);
		const workspace = await (
			await import('../src/lib/server/database')
		).workspaceFromPostgres(owner.tenant.slug, owner.userId, 'owner');
		expect(workspace?.contacts.find((contact) => contact.id === contactId)?.stage).toBe(
			'leadership'
		);
	});

	it('blocks financially privileged proposals for analyst members at the database-backed tenant boundary', async () => {
		const giftProposal = {
			answer: 'I can prepare a gift event.',
			toolCalls: [],
			proposedAction: {
				title: 'Record gift',
				resource: 'gifts',
				action: 'create',
				dataJson: JSON.stringify({
					amountMinor: 2500,
					currency: 'USD',
					kind: 'one_time',
					status: 'recorded'
				})
			}
		};
		const response = await execute(
			{
				locals: { session: analystSession },
				request: new Request('http://localhost/api/v1/ai/execute', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ message: 'Record this gift.' })
				})
			} as never,
			{ fetcher: fakeTransport(giftProposal, seen) }
		);
		expect(response.status).toBe(403);
		expect(await response.json()).toMatchObject({
			error: 'Recording gift events requires a finance manager or administrator.'
		});
		const prompt = JSON.parse(String(seen.at(-1)?.body.input)) as {
			crmContext: {
				contacts: unknown[];
				gifts: unknown[];
				campaigns: unknown[];
				counts: { contacts: number | null; gifts: number | null };
			};
		};
		expect(prompt.crmContext.contacts).toEqual([]);
		expect(prompt.crmContext.gifts).toEqual([]);
		expect(prompt.crmContext.campaigns).toEqual([]);
		expect(prompt.crmContext.counts).toMatchObject({ contacts: null, gifts: null });
	});

	it('downloads a formula-escaped contact CSV only after the preview token is confirmed', async () => {
		await mutatePostgres(
			owner.tenant.slug,
			owner.userId,
			'contacts',
			{
				id: randomUUID(),
				name: '=HYPERLINK("https://example.test")',
				email: 'formula@example.test',
				stage: 'new'
			},
			'create'
		);
		const exportProposal = {
			answer: 'I prepared a contact export preview.',
			toolCalls: [],
			proposedAction: {
				title: 'Export contacts',
				resource: 'contacts',
				action: 'export',
				dataJson: JSON.stringify({ query: '' })
			}
		};
		const previewResponse = await execute(
			event(owner, 'owner', { message: 'Export the contacts.' }),
			{ fetcher: fakeTransport(exportProposal, seen) }
		);
		expect(previewResponse.status).toBe(200);
		const preview = (await previewResponse.json()).proposals[0] as {
			id: string;
			confirmationToken: string;
			preview: { data: { count: number; columns: string[] } };
		};
		expect(preview.preview.data.count).toBeGreaterThan(0);
		expect(preview.preview.data.columns).toContain('email');
		const downloaded = await confirm(
			event(
				owner,
				'owner',
				{ proposalId: preview.id, confirmationToken: preview.confirmationToken },
				'/api/v1/ai/confirm'
			)
		);
		expect(downloaded.headers.get('content-type')).toContain('text/csv');
		expect(await downloaded.text()).toContain('"\'=HYPERLINK(""https://example.test"")"');
	});

	it('enforces a user-specific dollar cap before contacting the provider', async () => {
		await setAssistantUserLimit(session, otherTenant.userId, {
			requestsPerDay: 5,
			tokensPerDay: 100000,
			costMicroUsdPerDay: 0
		});
		const before = seen.length;
		const response = await execute(
			{
				locals: { session: analystSession },
				request: new Request('http://localhost/api/v1/ai/execute', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ message: 'Review campaigns.' })
				})
			} as never,
			{ fetcher: fakeTransport(baseAnswer, seen) }
		);
		expect(response.status).toBe(429);
		expect(seen).toHaveLength(before);
	});

	it('enforces the tenant dollar ceiling before contacting the provider', async () => {
		await updateAssistantSettings(session, {
			enabled: true,
			inputUsdPerMillion: 0.000001,
			outputUsdPerMillion: 0.000002,
			requestsPerDay: 20,
			tokensPerDay: 100000,
			costMicroUsdPerDay: 1,
			maxOutputTokens: 400
		});
		const before = seen.length;
		const response = await execute(event(owner, 'owner', { message: 'Review campaigns.' }), {
			fetcher: fakeTransport(baseAnswer, seen)
		});
		expect(response.status).toBe(429);
		expect(seen).toHaveLength(before);
	});
});
