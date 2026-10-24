import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { AssistantError, executeAssistant } from '$lib/server/ai-assistant';

const requestSchema = z.object({ question: z.string().trim().min(1).max(1000) }).strict();

function requireHttps(request: Request) {
	if (process.env.NODE_ENV !== 'production') return;
	if (
		new URL(request.url).protocol !== 'https:' &&
		request.headers.get('x-forwarded-proto') !== 'https'
	)
		throw new AssistantError('AI prompts may only be submitted over HTTPS.', 400);
}

export async function POST({ request, locals }) {
	const session = locals.session;
	if (!session) return json({ error: 'Sign in before using AI tools.' }, { status: 401 });
	if (session.demo)
		return json({ error: 'AI tools are unavailable in demo mode.' }, { status: 503 });
	try {
		requireHttps(request);
		const body = requestSchema.parse(await request.json());
		const result = await executeAssistant(session, { message: body.question });
		return json({ ok: true, ...result }, { headers: { 'cache-control': 'private, no-store' } });
	} catch (error) {
		if (error instanceof z.ZodError)
			return json({ error: 'Question must be 1 to 1000 characters.' }, { status: 422 });
		const status =
			error instanceof AssistantError ? error.status : error instanceof SyntaxError ? 400 : 503;
		return json(
			{
				error:
					error instanceof AssistantError
						? error.message
						: status === 400
							? 'A JSON request is required.'
							: 'AI summary is temporarily unavailable.'
			},
			{ status, headers: { 'cache-control': 'no-store' } }
		);
	}
}
