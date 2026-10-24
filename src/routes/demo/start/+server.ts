import { error } from '@sveltejs/kit';
import { demoModeAvailable } from '$lib/server/store';
import { cookieName, makeSession } from '../../../hooks.server';

export function GET({ cookies }) {
	if (!demoModeAvailable()) throw error(404, 'Demo access is disabled.');
	cookies.set(
		cookieName,
		makeSession({ userId: 'demo:riverstone', tenantSlug: 'riverstone', role: 'owner', demo: true }),
		{
			path: '/',
			httpOnly: true,
			sameSite: 'lax',
			secure: process.env.NODE_ENV === 'production',
			maxAge: 60 * 60 * 12
		}
	);
	return new Response(null, {
		status: 303,
		headers: { location: '/app/riverstone/overview', 'cache-control': 'no-store' }
	});
}
