import { json } from '@sveltejs/kit';
import { createCampaign, listCampaigns, CampaignError } from '$lib/server/campaigns';
import { z } from 'zod';

const bodySchema = z.object({ tenant: z.string().min(1).max(80), draft: z.unknown() }).strict();
function fail(error: unknown) {
	const status =
		Number((error as { status?: number })?.status) ||
		((error as { name?: string })?.name === 'ZodError' ? 422 : 400);
	return json(
		{ error: error instanceof Error ? error.message : 'Campaign request failed.' },
		{ status }
	);
}
export async function GET({ locals }) {
	try {
		return json(
			{ campaigns: await listCampaigns(locals.session) },
			{ headers: { 'cache-control': 'private, no-store' } }
		);
	} catch (error) {
		return fail(error);
	}
}
export async function POST({ request, locals }) {
	try {
		const body = bodySchema.parse(await request.json());
		if (body.tenant !== locals.session?.tenantSlug)
			throw new CampaignError('Tenant access denied.', locals.session ? 403 : 401);
		return json(await createCampaign(locals.session, body.draft), {
			status: 201,
			headers: { 'cache-control': 'private, no-store' }
		});
	} catch (error) {
		return fail(error);
	}
}
