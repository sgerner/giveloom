import { json } from '@sveltejs/kit';
import { checkInRegistration } from '$lib/server/event-management';
export async function POST({ params, locals }) {
	try {
		return json(await checkInRegistration(locals.session, params.id, params.registrationId));
	} catch (error) {
		return json(
			{ error: error instanceof Error ? error.message : 'Check-in failed.' },
			{ status: Number((error as { status?: number })?.status) || 400 }
		);
	}
}
