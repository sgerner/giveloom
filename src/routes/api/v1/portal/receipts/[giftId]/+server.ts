import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { getPortalReceipt, PortalError } from '$lib/server/portal';

export async function GET({ cookies, params }) {
	if (!env.DATABASE_URL) return json({ error: 'Donor portal is unavailable.' }, { status: 503 });
	try {
		return json(await getPortalReceipt(cookies.get('giveloom_portal'), params.giftId), {
			headers: { 'cache-control': 'private, no-store' }
		});
	} catch (error) {
		return json(
			{
				error: error instanceof PortalError ? error.message : 'Acknowledgment could not be loaded.'
			},
			{ status: error instanceof PortalError ? error.status : 503 }
		);
	}
}
