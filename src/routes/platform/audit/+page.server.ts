import { error } from '@sveltejs/kit';
import { platformAudit } from '$lib/server/platform';
export async function load({ locals }) {
	try {
		return await platformAudit(locals.session);
	} catch (e) {
		error(Number((e as any)?.status) || 503, e instanceof Error ? e.message : 'Audit unavailable.');
	}
}
