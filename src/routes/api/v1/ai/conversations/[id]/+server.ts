import { json } from '@sveltejs/kit';
import { AssistantError, getConversation } from '$lib/server/ai-assistant';

export async function GET({ params, locals }) {
	if (!locals.session)
		return json({ error: 'Sign in before viewing conversations.' }, { status: 401 });
	try {
		return json(await getConversation(locals.session, params.id), {
			headers: { 'cache-control': 'private, no-store' }
		});
	} catch (error) {
		return json(
			{ error: error instanceof AssistantError ? error.message : 'Conversation is unavailable.' },
			{ status: error instanceof AssistantError ? error.status : 503 }
		);
	}
}
