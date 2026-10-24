import { json } from '@sveltejs/kit';
import { createTicketType } from '$lib/server/event-management';
export async function POST({ params, request, locals }) {
	try {
		return json(await createTicketType(locals.session, params.id, await request.json()), {
			status: 201
		});
	} catch (error) {
		return json(
			{ error: error instanceof Error ? error.message : 'Ticket type could not be created.' },
			{ status: Number((error as { status?: number })?.status) || 422 }
		);
	}
}
