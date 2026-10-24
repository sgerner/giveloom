import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { authRateLimit } from '$lib/server/auth-rate-limit';
import { requestEmailVerification } from '$lib/server/identity';
import { operatorTransactionalEmailConfigured } from '$lib/server/communications';

export async function POST({ request, getClientAddress }) {
	const limit = await authRateLimit('identity', getClientAddress(), 10, 60);
	if (!limit.available)
		return json({ error: 'Identity service is temporarily unavailable.' }, { status: 503 });
	if (!limit.allowed)
		return json({ error: 'Please wait before requesting another account email.' }, { status: 429 });
	if (!operatorTransactionalEmailConfigured())
		return json({ error: 'Transactional email is not configured.' }, { status: 503 });
	try {
		const body = z
			.object({ email: z.string().trim().email().max(254), tenant: z.string().min(1).max(80) })
			.strict()
			.parse(await request.json());
		const recipientLimit = await authRateLimit(
			'identity',
			`verify:${body.tenant}:${body.email.toLowerCase()}`,
			3,
			3600
		);
		if (!recipientLimit.available)
			return json({ error: 'Identity service is temporarily unavailable.' }, { status: 503 });
		if (recipientLimit.allowed) await requestEmailVerification(body.email, body.tenant);
	} catch (error) {
		if (error instanceof z.ZodError)
			return json({ error: 'Enter a valid email and workspace.' }, { status: 400 });
		console.error(
			'Verification request unavailable',
			error instanceof Error ? error.message : 'unknown'
		);
		return json({ error: 'Identity service is temporarily unavailable.' }, { status: 503 });
	}
	return json({ ok: true }, { status: 202, headers: { 'cache-control': 'no-store' } });
}
