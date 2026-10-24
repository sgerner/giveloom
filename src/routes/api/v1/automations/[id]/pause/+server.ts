import { json } from '@sveltejs/kit';
import { pauseAutomation } from '$lib/server/automation';
export async function POST({ params, locals }) {
	try {
		return json(await pauseAutomation(locals.session, params.id));
	} catch (error) {
		return json(
			{ error: error instanceof Error ? error.message : 'Pause failed.' },
			{ status: Number((error as { status?: number })?.status) || 400 }
		);
	}
}
