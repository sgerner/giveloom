import { json } from '@sveltejs/kit';
import { decideAutomationApproval } from '$lib/server/automation';
import { z } from 'zod';

const fail = (error: unknown) =>
	json(
		{ error: error instanceof Error ? error.message : 'Workflow approval update failed.' },
		{
			status:
				Number((error as { status?: number })?.status) ||
				((error as { name?: string })?.name === 'ZodError' ? 422 : 400)
		}
	);
export async function POST({ params, request, locals }) {
	try {
		const body = z
			.object({ approved: z.boolean() })
			.strict()
			.parse(await request.json());
		return json(await decideAutomationApproval(locals.session, params.id, body.approved));
	} catch (error) {
		return fail(error);
	}
}
