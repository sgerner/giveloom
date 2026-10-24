import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { AssistantError, createConversation, listConversations } from '$lib/server/ai-assistant';
import { readLimitedBody } from '$lib/server/request';

export async function GET({ locals }) {
	if (!locals.session)
		return json({ error: 'Sign in before viewing conversations.' }, { status: 401 });
	try {
		return json(await listConversations(locals.session), {
			headers: { 'cache-control': 'private, no-store' }
		});
	} catch (error) {
		return json(
			{
				error:
					error instanceof AssistantError ? error.message : 'Conversation history is unavailable.'
			},
			{ status: error instanceof AssistantError ? error.status : 503 }
		);
	}
}

export async function POST({ request, locals }) {
	if (!locals.session)
		return json({ error: 'Sign in before creating a conversation.' }, { status: 401 });
	try {
		const body = z
			.object({ title: z.string().max(120).optional() })
			.strict()
			.parse(JSON.parse(await readLimitedBody(request, 2_048)));
		return json(await createConversation(locals.session, body.title), {
			status: 201,
			headers: { 'cache-control': 'private, no-store' }
		});
	} catch (error) {
		if (error instanceof z.ZodError)
			return json({ error: 'Conversation title is invalid.' }, { status: 422 });
		return json(
			{
				error:
					error instanceof AssistantError
						? error.message
						: error instanceof SyntaxError
							? 'A JSON request is required.'
							: 'Conversation could not be created.'
			},
			{
				status:
					error instanceof AssistantError ? error.status : error instanceof SyntaxError ? 400 : 503
			}
		);
	}
}
