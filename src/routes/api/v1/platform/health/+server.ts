import { json } from '@sveltejs/kit';
import { adminResponseError, getPlatformHealth } from '$lib/server/admin';
export async function GET({ locals }) {
	try {
		return json(await getPlatformHealth(locals.session), {
			headers: { 'cache-control': 'private, no-store' }
		});
	} catch (error) {
		const result = adminResponseError(error);
		return json(
			{ error: result.error },
			{ status: result.status, headers: { 'cache-control': 'no-store' } }
		);
	}
}
