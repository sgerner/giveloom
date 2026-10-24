import { json } from '@sveltejs/kit';
import { getEvent, updateEvent } from '$lib/server/event-management';
function fail(error: unknown) {
	return json(
		{ error: error instanceof Error ? error.message : 'Event request failed.' },
		{ status: Number((error as { status?: number })?.status) || 400 }
	);
}
export async function GET({ params, locals }) {
	try {
		return json(await getEvent(locals.session, params.id), {
			headers: { 'cache-control': 'private, no-store' }
		});
	} catch (error) {
		return fail(error);
	}
}
export async function PATCH({ params, request, locals }) {
	try {
		return json(await updateEvent(locals.session, params.id, await request.json()), {
			headers: { 'cache-control': 'private, no-store' }
		});
	} catch (error) {
		return fail(error);
	}
}
