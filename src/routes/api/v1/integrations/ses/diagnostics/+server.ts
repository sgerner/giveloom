import { json } from '@sveltejs/kit';
import { IntegrationError, diagnoseSesIntegration } from '$lib/server/integrations';

export async function GET({ locals }) {
	if (!locals.session)
		return json({ error: 'Sign in before checking sender diagnostics.' }, { status: 401 });
	if (locals.session.demo)
		return json({ error: 'Sender diagnostics are unavailable in demo mode.' }, { status: 403 });
	try {
		return json(await diagnoseSesIntegration(locals.session), {
			headers: { 'cache-control': 'private, no-store' }
		});
	} catch (error) {
		const status = error instanceof IntegrationError ? error.status : 503;
		return json(
			{
				error:
					error instanceof Error ? error.message : 'Sender diagnostics are temporarily unavailable.'
			},
			{ status, headers: { 'cache-control': 'no-store' } }
		);
	}
}
