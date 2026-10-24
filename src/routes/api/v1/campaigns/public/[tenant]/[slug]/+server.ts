import { json } from '@sveltejs/kit';
import { publicCampaign } from '$lib/server/campaigns';
export async function GET({ params, url }) {
	try {
		const page = await publicCampaign(
			params.tenant,
			params.slug,
			url.searchParams.get('ref') || undefined
		);
		if (!page)
			return json(
				{ error: 'Campaign not found.' },
				{ status: 404, headers: { 'cache-control': 'no-store' } }
			);
		return json(page, { headers: { 'cache-control': 'private, no-store' } });
	} catch {
		return json({ error: 'Campaign not found.' }, { status: 404 });
	}
}
