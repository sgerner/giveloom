import { json } from '@sveltejs/kit';
import { createEvent, EventError, listEvents } from '$lib/server/event-management';
import { z } from 'zod';
function fail(error: unknown) {
	return json(
		{ error: error instanceof Error ? error.message : 'Event request failed.' },
		{
			status:
				Number((error as { status?: number })?.status) ||
				((error as { name?: string }).name === 'ZodError' ? 422 : 400)
		}
	);
}
export async function GET({ locals }) {
	try {
		return json(
			{ events: await listEvents(locals.session) },
			{ headers: { 'cache-control': 'private, no-store' } }
		);
	} catch (error) {
		return fail(error);
	}
}
export async function POST({ request, locals }) {
	try {
		const body = z
			.object({ tenant: z.string().min(1).max(80), event: z.unknown() })
			.strict()
			.parse(await request.json());
		if (body.tenant !== locals.session?.tenantSlug)
			throw new EventError('Tenant access denied.', locals.session ? 403 : 401);
		return json(await createEvent(locals.session, body.event), { status: 201 });
	} catch (error) {
		return fail(error);
	}
}
