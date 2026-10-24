import { json } from '@sveltejs/kit';
import { updateTask } from '$lib/server/stewardship';
export async function PATCH({ params, request, locals }) {
	try {
		return json(await updateTask(locals.session, params.id, await request.json()), {
			headers: { 'cache-control': 'private, no-store' }
		});
	} catch (error) {
		return json(
			{ error: error instanceof Error ? error.message : 'Task update failed.' },
			{ status: Number((error as { status?: number })?.status) || 400 }
		);
	}
}
