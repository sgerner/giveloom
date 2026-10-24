import { json } from '@sveltejs/kit';
import argon2 from 'argon2';
import { z } from 'zod';
import { authRateLimit } from '$lib/server/auth-rate-limit';
import { resetPasswordToken } from '$lib/server/identity';
export async function POST({ request, getClientAddress }) {
	const limit = await authRateLimit('identity', getClientAddress(), 8, 3600);
	if (!limit.available)
		return json({ error: 'Identity service is temporarily unavailable.' }, { status: 503 });
	if (!limit.allowed) return json({ error: 'Please wait before trying again.' }, { status: 429 });
	try {
		const { token, password } = z
			.object({ token: z.string().min(20).max(256), password: z.string().min(12).max(128) })
			.strict()
			.parse(await request.json());
		const digest = await argon2.hash(password, {
			type: argon2.argon2id,
			memoryCost: 19456,
			timeCost: 2,
			parallelism: 1
		});
		const ok = await resetPasswordToken(token, digest);
		return ok
			? json({ ok: true })
			: json(
					{ error: 'This password link is invalid, expired, or already used.' },
					{ status: 400 }
				);
	} catch (error) {
		if (error instanceof z.ZodError)
			return json(
				{ error: 'Use a valid recovery link and a password of at least 12 characters.' },
				{ status: 400 }
			);
		console.error('Password reset unavailable', error instanceof Error ? error.message : 'unknown');
		return json({ error: 'Identity service is temporarily unavailable.' }, { status: 503 });
	}
}
