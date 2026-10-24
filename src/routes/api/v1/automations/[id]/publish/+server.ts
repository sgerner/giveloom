import { json } from '@sveltejs/kit';
import { publishAutomation } from '$lib/server/automation';
export async function POST({ params, locals }) {
	try {
		return json(await publishAutomation(locals.session, params.id));
	} catch (error) {
		return json(
			{ error: error instanceof Error ? error.message : 'Publish failed.' },
			{ status: Number((error as { status?: number })?.status) || 400 }
		);
	}
}
