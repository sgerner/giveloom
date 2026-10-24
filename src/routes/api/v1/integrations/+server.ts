import { json } from '@sveltejs/kit';
import { getIntegrationStatuses, IntegrationError } from '$lib/server/integrations';

export async function GET({ locals }) {
	const session = locals.session;
	if (!session) return json({ error: 'Sign in before viewing integrations.' }, { status: 401 });
	if (session.demo)
		return json(
			{
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
			},
			{ headers: { 'cache-control': 'private, no-store' } }
		);
	try {
		return json(await getIntegrationStatuses(session), {
			headers: { 'cache-control': 'private, no-store' }
		});
	} catch (error) {
		const status = error instanceof IntegrationError ? error.status : 503;
		return json(
			{
				error:
					error instanceof IntegrationError
						? error.message
						: 'Integration status is temporarily unavailable.'
			},
			{ status, headers: { 'cache-control': 'no-store' } }
		);
	}
}
