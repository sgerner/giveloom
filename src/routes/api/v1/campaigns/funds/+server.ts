import { json } from '@sveltejs/kit';
import { listFunds, saveFund, CampaignError } from '$lib/server/campaigns';
import { z } from 'zod';
function fail(error: unknown) {
	return json(
		{ error: error instanceof Error ? error.message : 'Fund request failed.' },
		{
			status:
				Number((error as { status?: number })?.status) ||
				((error as { name?: string }).name === 'ZodError' ? 422 : 400)
		}
	);
}
export async function GET({ locals }) {
	try {
		return json({ funds: await listFunds(locals.session) });
	} catch (error) {
		return fail(error);
	}
}
export async function POST({ request, locals }) {
	try {
		const body = z
			.object({ tenant: z.string(), fund: z.unknown() })
			.strict()
			.parse(await request.json());
		if (body.tenant !== locals.session?.tenantSlug)
			throw new CampaignError('Tenant access denied.', locals.session ? 403 : 401);
		return json(await saveFund(locals.session, body.fund), { status: 201 });
	} catch (error) {
		return fail(error);
	}
}
