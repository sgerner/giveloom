import { json } from '@sveltejs/kit';
import {
	ApiTokenError,
	apiTokenResponseError,
	createApiToken,
	listApiTokens
} from '$lib/server/api-tokens';
export async function GET({ locals }) {
	try {
		if (!locals.session) return json({ error: 'Sign in first.' }, { status: 401 });
		return json(await listApiTokens(locals.session), {
			headers: { 'cache-control': 'private, no-store' }
		});
	} catch (error) {
		const result =
			error instanceof ApiTokenError ? apiTokenResponseError(error) : apiTokenResponseError(error);
		return json({ error: result.error }, { status: result.status });
	}
}
export async function POST({ locals, request }) {
	try {
		if (!locals.session) return json({ error: 'Sign in first.' }, { status: 401 });
		return json(await createApiToken(locals.session, await request.json()), {
			status: 201,
			headers: { 'cache-control': 'no-store' }
		});
	} catch (error) {
		const result = apiTokenResponseError(error);
		return json({ error: result.error }, { status: result.status });
	}
}
