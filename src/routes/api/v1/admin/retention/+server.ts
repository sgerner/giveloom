import { json } from '@sveltejs/kit';
import { adminResponseError, getRetentionPolicy, setRetentionPolicy } from '$lib/server/admin';
export async function GET({ locals }) {
	try {
		if (!locals.session) return json({ error: 'Sign in first.' }, { status: 401 });
		return json(await getRetentionPolicy(locals.session), {
			headers: { 'cache-control': 'private, no-store' }
		});
	} catch (error) {
		const result = adminResponseError(error);
		return json({ error: result.error }, { status: result.status });
	}
}
export async function PUT({ locals, request }) {
	try {
		if (!locals.session) return json({ error: 'Sign in first.' }, { status: 401 });
		return json(await setRetentionPolicy(locals.session, await request.json()), {
			headers: { 'cache-control': 'no-store' }
		});
	} catch (error) {
		const result = adminResponseError(error);
		return json({ error: result.error }, { status: result.status });
	}
}
