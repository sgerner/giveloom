import { json } from '@sveltejs/kit';
import { listNotifications } from '$lib/server/stewardship';
export async function GET({ locals }) {
	try {
		return json(await listNotifications(locals.session), {
			headers: { 'cache-control': 'private, no-store' }
		});
	} catch (error) {
		return json(
			{ error: error instanceof Error ? error.message : 'Notification inbox unavailable.' },
			{ status: Number((error as { status?: number })?.status) || 400 }
		);
	}
}
