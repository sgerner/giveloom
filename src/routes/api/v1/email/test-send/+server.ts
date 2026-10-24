import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { CommunicationError, sendEmailTest } from '$lib/server/communications';
const schema = z.object({ emailId: z.string().uuid(), approved: z.literal(true) }).strict();
export async function POST({ request, locals }) {
	if (!locals.session) return json({ error: 'Sign in before sending a test.' }, { status: 401 });
	try {
		const result = await sendEmailTest(locals.session, schema.parse(await request.json()));
		return json({ ok: true, ...result }, { headers: { 'cache-control': 'no-store' } });
	} catch (error) {
		const invalid = error instanceof z.ZodError;
		return json(
			{
				error:
					error instanceof CommunicationError
						? error.message
						: invalid
							? 'Review the draft and confirm the test send.'
							: 'Test email is temporarily unavailable.'
			},
			{
				status: error instanceof CommunicationError ? error.status : invalid ? 400 : 503,
				headers: { 'cache-control': 'no-store' }
			}
		);
	}
}
