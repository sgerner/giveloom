import { json } from '@sveltejs/kit';
import { adminResponseError, revokeWebhookEndpoint } from '$lib/server/admin';
export async function DELETE({ locals, params }) {
	try {
		if (!locals.session) return json({ error: 'Sign in first.' }, { status: 401 });
		return json(await revokeWebhookEndpoint(locals.session, params.id), {
			headers: { 'cache-control': 'no-store' }
		});
	} catch (error) {
		const result = adminResponseError(error);
		return json({ error: result.error }, { status: result.status });
	}
}
