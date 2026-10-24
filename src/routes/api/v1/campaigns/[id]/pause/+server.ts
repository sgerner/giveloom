import { json } from '@sveltejs/kit';
import { pauseCampaign } from '$lib/server/campaigns';
export async function POST({ params, locals }) {
	try {
		return json(await pauseCampaign(locals.session, params.id), {
			headers: { 'cache-control': 'no-store' }
		});
	} catch (error) {
		return json(
			{ error: error instanceof Error ? error.message : 'Campaign could not be paused.' },
			{ status: Number((error as { status?: number })?.status) || 409 }
		);
	}
}
