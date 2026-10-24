import { json } from '@sveltejs/kit';
import { getEvent, EventError } from '$lib/server/event-management';
export async function GET({ params, locals }) {
	try {
		const result = await getEvent(locals.session, params.id);
		if (
			!locals.session ||
			!['owner', 'admin', 'fundraising_manager', 'fundraiser'].includes(locals.session.role)
		)
			throw new EventError('Role cannot view attendee details.', 403);
		return json(
			{ registrations: result.registrations },
			{ headers: { 'cache-control': 'private, no-store' } }
		);
	} catch (error) {
		return json(
			{ error: error instanceof Error ? error.message : 'Attendee list unavailable.' },
			{ status: Number((error as { status?: number })?.status) || 400 }
		);
	}
}
