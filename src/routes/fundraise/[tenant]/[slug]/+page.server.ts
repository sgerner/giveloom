import { error } from '@sveltejs/kit';
import { publicFundraisingPage } from '$lib/server/campaigns';
export async function load({ params }) {
	const page = await publicFundraisingPage(params.tenant, params.slug);
	if (!page) error(404, 'Fundraising page not found');
	return page;
}
