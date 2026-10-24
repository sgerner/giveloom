import { json } from '@sveltejs/kit';
import {
	createFundraisingPage,
	listCampaignFundraisers,
	CampaignError
} from '$lib/server/campaigns';
function fail(error: unknown) {
	return json(
		{ error: error instanceof Error ? error.message : 'Fundraising page request failed.' },
		{ status: Number((error as { status?: number })?.status) || 400 }
	);
}
export async function GET({ params, locals }) {
	try {
		return json({ pages: await listCampaignFundraisers(locals.session, params.id) });
	} catch (error) {
		return fail(error);
	}
}
export async function POST({ params, request, locals }) {
	try {
		return json(await createFundraisingPage(locals.session, params.id, await request.json()), {
			status: 201
		});
	} catch (error) {
		return fail(error);
	}
}
