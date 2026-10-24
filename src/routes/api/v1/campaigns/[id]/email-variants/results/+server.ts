import { json } from '@sveltejs/kit';
import { CommunicationError, campaignEmailVariantResults } from '$lib/server/communications';

export async function GET({ params, locals }) {
	if (!locals.session)
		return json({ error: 'Sign in before viewing campaign results.' }, { status: 401 });
	try {
		return json(await campaignEmailVariantResults(locals.session, params.id), {
			headers: { 'cache-control': 'private, no-store' }
		});
	} catch (error) {
		const status = error instanceof CommunicationError ? error.status : 503;
		return json(
			{
				error:
					error instanceof CommunicationError ? error.message : 'Campaign results are unavailable.'
			},
			{ status, headers: { 'cache-control': 'no-store' } }
		);
	}
}
