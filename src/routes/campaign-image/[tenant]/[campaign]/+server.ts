import { getPublicCampaignHero } from '$lib/server/files';

export async function GET({ params }) {
	const image = await getPublicCampaignHero(params.tenant, params.campaign);
	if (!image)
		return new Response(null, { status: 404, headers: { 'cache-control': 'public, max-age=60' } });
	return new Response(image.stream, {
		headers: {
			'content-type': image.mediaType,
			'content-disposition': 'inline',
			'x-content-type-options': 'nosniff',
			'cache-control': 'public, max-age=300',
			'cross-origin-resource-policy': 'cross-origin'
		}
	});
}
