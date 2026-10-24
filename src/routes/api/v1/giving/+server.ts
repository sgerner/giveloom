import { json } from '@sveltejs/kit';
import { givingSnapshot, givingCommand } from '$lib/server/giving';
import { serviceResponseError } from '$lib/server/tenant-service';
import { readLimitedBody } from '$lib/server/request';
import { ApiTokenError, apiTokenResponseError, resolveApiSession } from '$lib/server/api-tokens';
export async function GET({ url, locals, request }) {
	try {
		const session = await resolveApiSession(request, locals.session, 'giving:read');
		return json(
			await givingSnapshot(session, url.searchParams.get('contactId') || undefined, {
				cursor: url.searchParams.get('cursor') || undefined,
				limit: Number(url.searchParams.get('limit')) || undefined,
				q: url.searchParams.get('q') || undefined,
				kind: url.searchParams.get('kind') || undefined,
				month: url.searchParams.get('month') || undefined,
				subscriptionCursor: url.searchParams.get('subscriptionCursor') || undefined
			}),
			{
				headers: { 'cache-control': 'private, no-store' }
			}
		);
	} catch (e) {
		const error = e instanceof ApiTokenError ? apiTokenResponseError(e) : serviceResponseError(e);
		return json({ error: error.error }, { status: error.status });
	}
}
export async function POST({ request, locals }) {
	try {
		const session = await resolveApiSession(request, locals.session, 'giving:write');
		return json(
			{
				ok: true,
				result: await givingCommand(session, JSON.parse(await readLimitedBody(request, 100000)))
			},
			{ headers: { 'cache-control': 'private, no-store' } }
		);
	} catch (e) {
		const error = e instanceof ApiTokenError ? apiTokenResponseError(e) : serviceResponseError(e);
		return json({ error: error.error }, { status: error.status });
	}
}
