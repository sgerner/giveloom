import { error, redirect } from '@sveltejs/kit';
import { AdminError, getPlatformHealth } from '$lib/server/admin';
export async function load({ locals }) {
	try {
		return await getPlatformHealth(locals.session);
	} catch (e) {
		if (e instanceof AdminError) throw error(e.status, e.message);
		if (e instanceof Error) throw error(503, 'Platform health is unavailable.');
		throw redirect(303, '/');
	}
}
