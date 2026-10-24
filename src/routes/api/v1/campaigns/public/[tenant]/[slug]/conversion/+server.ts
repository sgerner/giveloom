import { json } from '@sveltejs/kit';
import { recordCampaignConversion } from '$lib/server/campaigns';
import { z } from 'zod';
export async function POST({ params, request }) {
	try {
		const body = z
			.object({ campaignId: z.string().uuid(), variantId: z.string().uuid().optional() })
			.strict()
			.parse(await request.json());
		await recordCampaignConversion(params.tenant, body.campaignId, body.variantId);
		return json({ ok: true }, { headers: { 'cache-control': 'no-store' } });
	} catch {
		return json({ error: 'Campaign conversion could not be recorded.' }, { status: 400 });
	}
}
