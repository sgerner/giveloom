import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { createPortalBillingSession, PortalError } from '$lib/server/portal';

export async function POST({ cookies }) {
	if (!env.DATABASE_URL)
		return json({ error: 'Billing management is unavailable.' }, { status: 503 });
	try {
		const result = await createPortalBillingSession(cookies.get('giveloom_portal'));
		return json(result, { headers: { 'cache-control': 'no-store' } });
	} catch (error) {
		return json(
			{
				error:
					error instanceof PortalError
						? error.message
						: 'Billing management is temporarily unavailable.'
			},
			{ status: error instanceof PortalError ? error.status : 503 }
		);
	}
}
