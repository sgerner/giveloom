import { json } from '@sveltejs/kit';
import { publishEvent } from '$lib/server/event-management';
export async function POST({ params, locals }) {
	try {
		return json(await publishEvent(locals.session, params.id));
	} catch (error) {
		return json(
			{ error: error instanceof Error ? error.message : 'Event could not be published.' },
			{ status: Number((error as { status?: number })?.status) || 422 }
		);
	}
}
