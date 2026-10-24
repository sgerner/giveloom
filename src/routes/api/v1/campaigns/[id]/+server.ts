import { json } from '@sveltejs/kit';
import {
	getCampaign,
	saveCampaignDraft,
	unpublishCampaign,
	CampaignError
} from '$lib/server/campaigns';
function fail(error: unknown) {
	return json(
		{ error: error instanceof Error ? error.message : 'Campaign request failed.' },
		{
			status:
				Number((error as { status?: number })?.status) ||
				((error as { name?: string }).name === 'ZodError' ? 422 : 400)
		}
	);
}
export async function GET({ params, locals }) {
	try {
		return json(await getCampaign(locals.session, params.id), {
			headers: { 'cache-control': 'private, no-store' }
		});
	} catch (error) {
		return fail(error);
	}
}
export async function PATCH({ params, request, locals }) {
	try {
		return json(await saveCampaignDraft(locals.session, params.id, await request.json()), {
			headers: { 'cache-control': 'private, no-store' }
		});
	} catch (error) {
		return fail(error);
	}
}
export async function DELETE({ params, locals }) {
	try {
		return json(await unpublishCampaign(locals.session, params.id));
	} catch (error) {
		return fail(error);
	}
}
