import { json } from '@sveltejs/kit';
import { resumeCampaign } from '$lib/server/campaigns';
export async function POST({ params, locals }) {
	try {
		return json(await resumeCampaign(locals.session, params.id), {
			headers: { 'cache-control': 'no-store' }
		});
	} catch (error) {
		return json(
			{ error: error instanceof Error ? error.message : 'Campaign could not be resumed.' },
			{ status: Number((error as { status?: number })?.status) || 409 }
		);
	}
}
