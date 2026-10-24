import { json } from '@sveltejs/kit';
import { publicRegistrationStatus } from '$lib/server/event-management';
export async function GET({ params, url }) {
	try {
		const ref = url.searchParams.get('ref') || '';
		return json(await publicRegistrationStatus(params.tenant, params.slug, ref), {
			headers: { 'cache-control': 'no-store' }
		});
	} catch (error) {
		return json(
			{ error: error instanceof Error ? error.message : 'Registration status unavailable.' },
			{
				status: Number((error as { status?: number })?.status) || 404,
				headers: { 'cache-control': 'no-store' }
			}
		);
	}
}
