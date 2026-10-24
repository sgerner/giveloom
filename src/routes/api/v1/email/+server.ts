import { json } from '@sveltejs/kit';
import { CommunicationError, listEmailDrafts } from '$lib/server/communications';

export async function GET({ locals, url }) {
	try {
		if (!locals.session) return json({ error: 'Sign in before viewing email.' }, { status: 401 });
		const limitValue = url.searchParams.get('limit');
		return json(
			await listEmailDrafts(locals.session, {
				cursor: url.searchParams.get('cursor'),
				limit: limitValue ? Number(limitValue) : undefined,
				draftId: url.searchParams.get('id')
			}),
			{
				headers: { 'cache-control': 'private, no-store' }
			}
		);
	} catch (error) {
		const status = error instanceof CommunicationError ? error.status : 503;
		return json(
			{
				error:
					error instanceof CommunicationError
						? error.message
						: 'Email service is temporarily unavailable.'
			},
			{ status, headers: { 'cache-control': 'no-store' } }
		);
	}
}
