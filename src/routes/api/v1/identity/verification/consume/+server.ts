import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { authRateLimit } from '$lib/server/auth-rate-limit';
import { verifyEmailToken } from '$lib/server/identity';
export async function POST({ request, getClientAddress }) {
	const limit = await authRateLimit('identity', getClientAddress(), 10, 60);
	if (!limit.available)
		return json({ error: 'Identity service is temporarily unavailable.' }, { status: 503 });
	if (!limit.allowed) return json({ error: 'Please wait before trying again.' }, { status: 429 });
	try {
		const { token } = z
			.object({ token: z.string().min(20).max(256) })
			.strict()
			.parse(await request.json());
		const ok = await verifyEmailToken(token);
		return ok
			? json({ ok: true })
			: json(
					{ error: 'This confirmation link is invalid, expired, or already used.' },
					{ status: 400 }
				);
	} catch (error) {
		if (error instanceof z.ZodError)
			return json({ error: 'Confirmation link is invalid.' }, { status: 400 });
		console.error(
			'Email verification unavailable',
			error instanceof Error ? error.message : 'unknown'
		);
		return json({ error: 'Identity service is temporarily unavailable.' }, { status: 503 });
	}
}
