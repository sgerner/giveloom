import { error } from '@sveltejs/kit';
import { publicEvent } from '$lib/server/event-management';
export async function load({ params }) {
	const event = await publicEvent(params.tenant, params.slug);
	if (!event) error(404, 'Event not found');
	return event;
}
