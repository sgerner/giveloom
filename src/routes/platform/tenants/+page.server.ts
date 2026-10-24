import { error, redirect } from '@sveltejs/kit';
import { AdminError, listPlatformTenants } from '$lib/server/admin';
export async function load({ locals }) {
	try {
		return { tenants: await listPlatformTenants(locals.session) };
	} catch (e) {
		if (e instanceof AdminError) throw error(e.status, e.message);
		if (e instanceof Error) throw error(503, 'Platform tenant list is unavailable.');
		throw redirect(303, '/');
	}
}
