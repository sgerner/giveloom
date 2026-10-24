import { json } from '@sveltejs/kit';
import { AssistantError, listAssistantTools } from '$lib/server/ai-assistant';

export async function GET({ url, locals }) {
	if (!locals.session) return json({ error: 'Sign in before using AI tools.' }, { status: 401 });
	if (
		url.searchParams.get('tenant') &&
		url.searchParams.get('tenant') !== locals.session.tenantSlug
	)
		return json({ error: 'The requested tenant is not in your active session.' }, { status: 403 });
	try {
		return json(await listAssistantTools(locals.session), {
			headers: { 'cache-control': 'private, no-store' }
		});
	} catch (error) {
		return json(
			{
				error:
					error instanceof AssistantError ? error.message : 'AI tools are temporarily unavailable.'
			},
			{
				status: error instanceof AssistantError ? error.status : 503,
				headers: { 'cache-control': 'no-store' }
			}
		);
	}
}
