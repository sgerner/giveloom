import { json } from '@sveltejs/kit';
import { validateAutomation } from '$lib/server/automation';
export async function POST({ params, locals }) {
	try {
		return json(await validateAutomation(locals.session, params.id));
	} catch (error) {
		return json(
			{ error: error instanceof Error ? error.message : 'Validation failed.' },
			{ status: Number((error as { status?: number })?.status) || 400 }
		);
	}
}
