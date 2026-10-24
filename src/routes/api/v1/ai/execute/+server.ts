import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { AssistantError, executeAssistant } from '$lib/server/ai-assistant';
import { readLimitedBody } from '$lib/server/request';
import type { RequestEvent } from './$types';

export async function POST(event: RequestEvent, dependencies: { fetcher?: typeof fetch } = {}) {
	const { request, locals } = event;
	if (!locals.session)
		return json({ error: 'Sign in before using the AI assistant.' }, { status: 401 });
	if (
		process.env.NODE_ENV === 'production' &&
		new URL(request.url).protocol !== 'https:' &&
		request.headers.get('x-forwarded-proto') !== 'https'
	)
		return json({ error: 'AI requests may only be submitted over HTTPS.' }, { status: 400 });
	try {
		const body = z
			.object({
				tenant: z.string().min(1).optional(),
				message: z.string().trim().min(1).max(2000),
				conversationId: z.string().uuid().optional()
			})
			.strict()
			.parse(JSON.parse(await readLimitedBody(request, 12_000)));
		if (body.tenant && body.tenant !== locals.session.tenantSlug)
			return json(
				{ error: 'The requested tenant is not in your active session.' },
				{ status: 403 }
			);
		const response = await executeAssistant(locals.session, body, {
			fetcher: dependencies.fetcher
		});
		return json(response, { headers: { 'cache-control': 'private, no-store' } });
	} catch (error) {
		if (error instanceof z.ZodError)
			return json({ error: 'Message or conversation id is invalid.' }, { status: 422 });
		return json(
			{
				error:
					error instanceof AssistantError
						? error.message
						: error instanceof SyntaxError
							? 'A JSON request is required.'
							: 'AI request could not be completed.'
			},
			{
				status:
					error instanceof AssistantError ? error.status : error instanceof SyntaxError ? 400 : 503,
				headers: { 'cache-control': 'no-store' }
			}
		);
	}
}
