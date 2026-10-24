import { json } from '@sveltejs/kit';
import { addVolunteerOpportunity } from '$lib/server/event-management';
export async function POST({ params, request, locals }) {
	try {
		return json(await addVolunteerOpportunity(locals.session, params.id, await request.json()), {
			status: 201
		});
	} catch (error) {
		return json(
			{
				error: error instanceof Error ? error.message : 'Volunteer opportunity could not be added.'
			},
			{ status: Number((error as { status?: number })?.status) || 422 }
		);
	}
}
