import { json } from '@sveltejs/kit';
import { signupVolunteer } from '$lib/server/event-management';
import { authRateLimit } from '$lib/server/auth-rate-limit';
export async function POST({ params, request, getClientAddress }) {
	try {
		const rate = await authRateLimit('event-volunteer', getClientAddress(), 12, 600);
		if (!rate.available)
			return json({ error: 'Sign-up protection is unavailable.' }, { status: 503 });
		if (!rate.allowed) return json({ error: 'Too many sign-up attempts.' }, { status: 429 });
		return json(await signupVolunteer(params.tenant, params.slug, await request.json()), {
			status: 201,
			headers: { 'cache-control': 'no-store' }
		});
	} catch (error) {
		return json(
			{ error: error instanceof Error ? error.message : 'Volunteer sign-up failed.' },
			{ status: Number((error as { status?: number })?.status) || 400 }
		);
	}
}
