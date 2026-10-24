import { describe, expect, it } from 'vitest';
import { GET as getIntegrations } from '../src/routes/api/v1/integrations/+server';
import { GET as getSesDiagnostics } from '../src/routes/api/v1/integrations/ses/diagnostics/+server';
import { PUT as putIntegration } from '../src/routes/api/v1/integrations/[provider]/+server';
import { POST as postAiSummary } from '../src/routes/api/v1/ai/summary/+server';
import { assertAiBudget, IntegrationError } from '../src/lib/server/integrations';

const demoSession = { userId: 'demo-owner', tenantSlug: 'riverstone', role: 'owner', demo: true };

describe('tenant integration API safety contracts', () => {
	it('returns only disabled provider placeholders in demo mode', async () => {
		const response = await getIntegrations({ locals: { session: demoSession } } as never);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			providers: [
				{
					provider: 'openai',
					configured: false,
					enabled: false,
					status: 'disabled_demo',
					metadata: {}
				},
				{
					provider: 'ses',
					configured: false,
					enabled: false,
					status: 'disabled_demo',
					metadata: {}
				}
			]
		});
	});

	it('does not expose live SES diagnostics in demo mode', async () => {
		const response = await getSesDiagnostics({ locals: { session: demoSession } } as never);
		expect(response.status).toBe(403);
		expect(await response.json()).toMatchObject({
			error: 'Sender diagnostics are unavailable in demo mode.'
		});
	});

	it('rejects real credentials in demo mode and permits only a disabled placeholder', async () => {
		const event = (body: unknown) =>
			({
				locals: { session: demoSession },
				params: { provider: 'openai' },
				request: new Request('http://localhost/api/v1/integrations/openai', {
					method: 'PUT',
					body: JSON.stringify(body),
					headers: { 'content-type': 'application/json' }
				})
			}) as never;
		const rejected = await putIntegration(
			event({ apiKey: 'sk-not-for-demo', model: 'gpt-test', enabled: true })
		);
		expect(rejected.status).toBe(403);
		const saved = await putIntegration(event({ enabled: false }));
		expect(saved.status).toBe(200);
		expect(await saved.json()).toMatchObject({
			configured: false,
			enabled: false,
			status: 'disabled_demo'
		});
	});

	it('does not invoke AI in demo mode', async () => {
		const response = await postAiSummary({
			locals: { session: demoSession },
			request: new Request('http://localhost/api/v1/ai/summary', {
				method: 'POST',
				body: JSON.stringify({ question: 'Summarize' }),
				headers: { 'content-type': 'application/json' }
			})
		} as never);
		expect(response.status).toBe(503);
		expect(await response.json()).toMatchObject({
			error: 'AI tools are unavailable in demo mode.'
		});
	});

	it('enforces bounded per-tenant AI request and character budgets', () => {
		expect(() =>
			assertAiBudget({ lastMinute: 4, lastDay: 99, charsLastDay: 99_000 }, 1_000)
		).not.toThrow();
		expect(() => assertAiBudget({ lastMinute: 5, lastDay: 0, charsLastDay: 0 }, 10)).toThrow(
			IntegrationError
		);
		expect(() => assertAiBudget({ lastMinute: 0, lastDay: 100, charsLastDay: 0 }, 10)).toThrow(
			/daily budget/
		);
		expect(() => assertAiBudget({ lastMinute: 0, lastDay: 0, charsLastDay: 99_999 }, 2)).toThrow(
			/daily budget/
		);
	});
});
