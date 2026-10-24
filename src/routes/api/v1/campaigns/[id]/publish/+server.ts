import { json } from '@sveltejs/kit';
import { publishCampaign } from '$lib/server/campaigns';
export async function POST({ params, locals }) {
	try {
		return json(await publishCampaign(locals.session, params.id), {
			headers: { 'cache-control': 'private, no-store' }
		});
	} catch (error) {
		return json(
			{ error: error instanceof Error ? error.message : 'Campaign could not be published.' },
			{ status: Number((error as { status?: number })?.status) || 422 }
		);
	}
}
