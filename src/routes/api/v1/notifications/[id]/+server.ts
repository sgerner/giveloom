import { json } from '@sveltejs/kit';
import { markNotificationRead } from '$lib/server/stewardship';
export async function PATCH({ params, locals }) {
	try {
		return json(await markNotificationRead(locals.session, params.id));
	} catch (error) {
		return json(
			{ error: error instanceof Error ? error.message : 'Notification update failed.' },
			{ status: Number((error as { status?: number })?.status) || 400 }
		);
	}
}
