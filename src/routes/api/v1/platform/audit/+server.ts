import { json } from '@sveltejs/kit';
import { platformAudit } from '$lib/server/platform';
import { serviceResponseError } from '$lib/server/tenant-service';
export async function GET({ locals }) {
	try {
		return json(await platformAudit(locals.session), {
			headers: { 'cache-control': 'private, no-store' }
		});
	} catch (e) {
		const p = serviceResponseError(e);
		return json({ error: p.error }, { status: p.status });
	}
}
