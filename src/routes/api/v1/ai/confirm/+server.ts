import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { AssistantError, confirmAssistantAction } from '$lib/server/ai-assistant';
import { readLimitedBody } from '$lib/server/request';

export async function POST({ request, locals }) {
	if (!locals.session)
		return json({ error: 'Sign in before confirming an AI proposal.' }, { status: 401 });
	try {
		const body = z
			.object({
				tenant: z.string().min(1).optional(),
				proposalId: z.string().uuid(),
				confirmationToken: z.string().min(32).max(100)
			})
			.strict()
			.parse(JSON.parse(await readLimitedBody(request, 4_096)));
		if (body.tenant && body.tenant !== locals.session.tenantSlug)
			return json(
				{ error: 'The requested tenant is not in your active session.' },
				{ status: 403 }
			);
		const result = await confirmAssistantAction(locals.session, body);
		if (result.export)
			return new Response(result.export.content, {
				status: 200,
				headers: {
					'content-type': 'text/csv; charset=utf-8',
					'content-disposition': `attachment; filename="${result.export.filename}"`,
					'cache-control': 'private, no-store',
					'x-content-type-options': 'nosniff'
				}
			});
		return json(result, { headers: { 'cache-control': 'private, no-store' } });
	} catch (error) {
		if (error instanceof z.ZodError)
			return json({ error: 'Confirmation is invalid.' }, { status: 422 });
		return json(
			{
				error:
					error instanceof AssistantError
						? error.message
						: error instanceof SyntaxError
							? 'A JSON request is required.'
							: 'The proposal could not be confirmed.'
			},
			{
				status:
					error instanceof AssistantError ? error.status : error instanceof SyntaxError ? 400 : 503,
				headers: { 'cache-control': 'no-store' }
			}
		);
	}
}
