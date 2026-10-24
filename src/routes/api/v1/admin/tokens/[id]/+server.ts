import { json } from '@sveltejs/kit';
import { ApiTokenError, apiTokenResponseError, revokeApiToken } from '$lib/server/api-tokens';
export async function DELETE({ locals, params }) {
	try {
		if (!locals.session) return json({ error: 'Sign in first.' }, { status: 401 });
		return json(await revokeApiToken(locals.session, params.id), {
			headers: { 'cache-control': 'no-store' }
		});
	} catch (error) {
		const result = apiTokenResponseError(error);
		return json({ error: result.error }, { status: result.status });
	}
}
