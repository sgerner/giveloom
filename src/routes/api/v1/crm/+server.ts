import { json } from '@sveltejs/kit';
import {
	crmSnapshot,
	crmCommand,
	duplicateCandidates,
	directoryMetadata,
	contactTimeline
} from '$lib/server/crm';
import { serviceResponseError } from '$lib/server/tenant-service';
import { readLimitedBody } from '$lib/server/request';
export async function GET({ url, locals }) {
	try {
		if (!locals.session) return json({ error: 'Sign in first.' }, { status: 401 });
		return json(
			url.searchParams.has('timeline')
				? await contactTimeline(locals.session, url.searchParams.get('timeline')!, {
						kind: url.searchParams.get('kind') || undefined,
						cursor: url.searchParams.get('cursor') || undefined
					})
				: url.searchParams.get('directory') === 'true'
					? await directoryMetadata(locals.session)
					: url.searchParams.get('duplicates') === 'true'
						? { duplicates: await duplicateCandidates(locals.session) }
						: await crmSnapshot(locals.session, url.searchParams.get('contactId') || undefined),
			{ headers: { 'cache-control': 'private, no-store' } }
		);
	} catch (e) {
		const error = serviceResponseError(e);
		return json({ error: error.error }, { status: error.status });
	}
}
export async function POST({ request, locals }) {
	try {
		if (!locals.session) return json({ error: 'Sign in first.' }, { status: 401 });
		return json(
			{
				ok: true,
				result: await crmCommand(
					locals.session,
					JSON.parse(await readLimitedBody(request, 1000000))
				)
			},
			{ headers: { 'cache-control': 'private, no-store' } }
		);
	} catch (e) {
		const error = serviceResponseError(e);
		return json({ error: error.error }, { status: error.status });
	}
}
