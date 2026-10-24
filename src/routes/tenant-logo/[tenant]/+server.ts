import { getPublicTenantLogo } from '$lib/server/branding';
export async function GET({ params }) {
	try {
		const image = await getPublicTenantLogo(params.tenant);
		if (!image)
			return new Response(null, {
				status: 404,
				headers: { 'cache-control': 'public, max-age=60', 'x-content-type-options': 'nosniff' }
			});
		return new Response(image.stream, {
			headers: {
				'content-type': image.mediaType,
				'content-disposition': 'inline',
				'x-content-type-options': 'nosniff',
				'cross-origin-resource-policy': 'cross-origin',
				'content-security-policy': "default-src 'none'; sandbox",
				'cache-control': 'public, max-age=300'
			}
		});
	} catch {
		return new Response(null, {
			status: 404,
			headers: { 'cache-control': 'public, max-age=60', 'x-content-type-options': 'nosniff' }
		});
	}
}
