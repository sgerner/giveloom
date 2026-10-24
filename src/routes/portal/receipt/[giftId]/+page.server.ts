import { error } from '@sveltejs/kit';
import { getPortalReceipt, PortalError } from '$lib/server/portal';

export async function load({ cookies, params, setHeaders }) {
	setHeaders({ 'cache-control': 'private, no-store' });
	try {
		return { receipt: await getPortalReceipt(cookies.get('giveloom_portal'), params.giftId) };
	} catch (reason) {
		throw error(
			reason instanceof PortalError ? reason.status : 503,
			reason instanceof Error ? reason.message : 'Acknowledgment could not be loaded.'
		);
	}
}
