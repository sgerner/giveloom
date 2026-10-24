import { json } from '@sveltejs/kit';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { env } from '$env/dynamic/private';
import { authRateLimit } from '$lib/server/auth-rate-limit';
import { requestPortalLink } from '$lib/server/portal';
import { readLimitedBody } from '$lib/server/request';

const schema = z
	.object({
		tenant: z
			.string()
			.min(1)
			.max(80)
			.regex(/^[a-z0-9-]+$/),
		email: z.string().trim().email().max(254)
	})
	.strict();
const accepted = () =>
	json(
		{ message: 'If an eligible donor account matches that address, a sign-in link will be sent.' },
		{ status: 202, headers: { 'cache-control': 'no-store' } }
	);

export async function POST({ request, getClientAddress }) {
	const limit = await authRateLimit('portal-link', getClientAddress(), 5, 900);
	if (!limit.available)
		return json(
			{ error: 'Portal sign-in is temporarily unavailable.' },
			{ status: 503, headers: { 'cache-control': 'no-store' } }
		);
	if (!limit.allowed) return accepted();
	let input: z.infer<typeof schema>;
	try {
		input = schema.parse(JSON.parse(await readLimitedBody(request, 4096)));
	} catch (error) {
		return json(
			{
				error:
					error instanceof RangeError
						? 'Request is too large.'
						: 'Enter a valid organization and email address.'
			},
			{ status: error instanceof RangeError ? 413 : 400 }
		);
	}
	const addressKey = createHash('sha256')
		.update(`${input.tenant}:${input.email.trim().normalize('NFKC').toLowerCase()}`)
		.digest('hex');
	const emailLimit = await authRateLimit('portal-email', addressKey, 3, 3600);
	if (!emailLimit.available)
		return json(
			{ error: 'Portal sign-in is temporarily unavailable.' },
			{ status: 503, headers: { 'cache-control': 'no-store' } }
		);
	if (!emailLimit.allowed) return accepted();
	if (!env.DATABASE_URL) {
		if (process.env.NODE_ENV === 'production')
			return json(
				{ error: 'Donor portal sign-in is unavailable.' },
				{ status: 503, headers: { 'cache-control': 'no-store' } }
			);
		return accepted();
	}
	try {
		await requestPortalLink(input.tenant, input.email);
		return accepted();
	} catch {
		return json(
			{ error: 'Donor portal sign-in is temporarily unavailable.' },
			{ status: 503, headers: { 'cache-control': 'no-store' } }
		);
	}
}
