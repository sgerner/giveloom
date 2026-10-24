import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { startManualAutomation } from '$lib/server/automation';
export async function POST({ params, request, locals }) {
	try {
		const { contactId } = z
			.object({ contactId: z.string().uuid() })
			.strict()
			.parse(await request.json());
		return json(await startManualAutomation(locals.session, params.id, contactId), { status: 202 });
	} catch (error) {
		return json(
			{ error: error instanceof Error ? error.message : 'Workflow launch failed.' },
			{
				status:
					Number((error as { status?: number })?.status) ||
					((error as { name?: string })?.name === 'ZodError' ? 422 : 400)
			}
		);
	}
}
