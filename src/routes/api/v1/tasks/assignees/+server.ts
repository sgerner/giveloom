import { json } from '@sveltejs/kit';
import { listTaskAssignees } from '$lib/server/stewardship';
export async function GET({ locals }) {
	try {
		return json(await listTaskAssignees(locals.session), {
			headers: { 'cache-control': 'private, no-store' }
		});
	} catch (error) {
		return json(
			{ error: error instanceof Error ? error.message : 'Assignees unavailable.' },
			{ status: Number((error as { status?: number })?.status) || 400 }
		);
	}
}
