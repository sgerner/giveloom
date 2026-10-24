import { json } from '@sveltejs/kit';
import { listAutomationRuns } from '$lib/server/automation';
export async function GET({ params, locals }) {
	try {
		return json(await listAutomationRuns(locals.session, params.id), {
			headers: { 'cache-control': 'private, no-store' }
		});
	} catch (error) {
		return json(
			{ error: error instanceof Error ? error.message : 'Run history unavailable.' },
			{ status: Number((error as { status?: number })?.status) || 400 }
		);
	}
}
