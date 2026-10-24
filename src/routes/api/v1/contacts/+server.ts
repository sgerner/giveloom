import { json } from '@sveltejs/kit';
import { contactPage } from '$lib/server/crm';
import { serviceResponseError } from '$lib/server/tenant-service';
import { ApiTokenError, apiTokenResponseError, resolveApiSession } from '$lib/server/api-tokens';
export async function GET({ url, locals, request }) {
	try {
		const session = await resolveApiSession(request, locals.session, 'contacts:read');
		return json(
			await contactPage(session, {
				query: url.searchParams.get('q') || '',
				stage: url.searchParams.get('stage') || undefined,
				cursor: url.searchParams.get('cursor') || undefined,
				limit: Number(url.searchParams.get('limit')) || 25
			}),
			{ headers: { 'cache-control': 'private, no-store' } }
		);
	} catch (e) {
		const error = e instanceof ApiTokenError ? apiTokenResponseError(e) : serviceResponseError(e);
		return json({ error: error.error }, { status: error.status });
	}
}
