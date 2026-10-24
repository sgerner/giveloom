import { json } from '@sveltejs/kit';
import { searchWorkspace } from '$lib/server/search';
import { serviceResponseError } from '$lib/server/tenant-service';
export async function GET({ locals, url }) {
	try {
		if (!locals.session) return json({ error: 'Sign in first.' }, { status: 401 });
		const requested = url.searchParams.get('tenant');
		if (requested && requested !== locals.session.tenantSlug)
			return json({ error: 'Tenant access denied.' }, { status: 403 });
		return json(await searchWorkspace(locals.session, url.searchParams.get('q') || ''), {
			headers: { 'cache-control': 'private, no-store' }
		});
	} catch (e) {
		const p = serviceResponseError(e);
		return json({ error: p.error }, { status: p.status });
	}
}
