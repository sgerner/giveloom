import { json } from '@sveltejs/kit';
import { adminResponseError, createWebhookEndpoint, listWebhookEndpoints } from '$lib/server/admin';
export async function GET({ locals }) {
	try {
		if (!locals.session) return json({ error: 'Sign in first.' }, { status: 401 });
		return json(await listWebhookEndpoints(locals.session), {
			headers: { 'cache-control': 'private, no-store' }
		});
	} catch (error) {
		const result = adminResponseError(error);
		return json({ error: result.error }, { status: result.status });
	}
}
export async function POST({ locals, request }) {
	try {
		if (!locals.session) return json({ error: 'Sign in first.' }, { status: 401 });
		return json(await createWebhookEndpoint(locals.session, await request.json()), {
			status: 201,
			headers: { 'cache-control': 'no-store' }
		});
	} catch (error) {
		const result = adminResponseError(error);
		return json({ error: result.error }, { status: result.status });
	}
}
