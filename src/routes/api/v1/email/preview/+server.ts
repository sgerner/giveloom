import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { CommunicationError, previewEmail } from '$lib/server/communications';

const schema = z
	.object({
		emailId: z.string().uuid(),
		segmentId: z.string().uuid().nullable().optional(),
		scheduledAt: z.string().datetime({ offset: true }).nullable().optional(),
		campaignId: z.string().uuid().nullable().optional(),
		variantSubjects: z
			.object({ A: z.string().max(998), B: z.string().max(998) })
			.strict()
			.nullable()
			.optional()
	})
	.strict();
export async function POST({ request, locals }) {
	if (!locals.session) return json({ error: 'Sign in before previewing a send.' }, { status: 401 });
	let input;
	try {
		input = schema.parse(await request.json());
	} catch {
		return json({ error: 'Provide a valid emailId.' }, { status: 400 });
	}
	try {
		return json(
			await previewEmail(locals.session, input.emailId, {
				segmentId: input.segmentId,
				scheduledAt: input.scheduledAt,
				campaignId: input.campaignId,
				variantSubjects: input.variantSubjects
			}),
			{
				headers: { 'cache-control': 'private, no-store' }
			}
		);
	} catch (error) {
		const status = error instanceof CommunicationError ? error.status : 503;
		return json(
			{
				error:
					error instanceof CommunicationError
						? error.message
						: 'Email preview is temporarily unavailable.'
			},
			{ status, headers: { 'cache-control': 'no-store' } }
		);
	}
}
