import { json } from '@sveltejs/kit';
import { campaignVersions } from '$lib/server/campaigns';
export async function GET({ params, locals }) {
	try {
		return json(
			{ versions: await campaignVersions(locals.session, params.id) },
			{ headers: { 'cache-control': 'private, no-store' } }
		);
	} catch (error) {
		return json(
			{ error: error instanceof Error ? error.message : 'Version history unavailable.' },
			{ status: Number((error as { status?: number })?.status) || 400 }
		);
	}
}
