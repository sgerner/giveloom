import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { authRateLimit } from '$lib/server/auth-rate-limit';
import { PaymentError, readDonationStatus } from '$lib/server/payments';
import { readLimitedBody } from '$lib/server/request';

const schema = z.object({ checkoutToken: z.string().min(40).max(1000) }).strict();
export async function POST({ request, getClientAddress }) {
	const rate = await authRateLimit('payment-status', getClientAddress(), 120, 600);
	if (!rate.available)
		return json({ error: 'Donation status is temporarily unavailable.' }, { status: 503 });
	if (!rate.allowed)
		return json({ error: 'Too many status checks. Try again shortly.' }, { status: 429 });
	try {
		const body = schema.parse(JSON.parse(await readLimitedBody(request, 2_000)));
		const result = await readDonationStatus(body.checkoutToken);
		return json(
			{ status: result.status, updatedAt: result.updatedAt },
			{ headers: { 'cache-control': 'no-store' } }
		);
	} catch (error) {
		return json(
			{
				error:
					error instanceof RangeError
						? 'Status request is too large.'
						: error instanceof PaymentError
							? error.message
							: 'Donation status is temporarily unavailable.'
			},
			{
				status: error instanceof RangeError ? 413 : (error as PaymentError).status || 400,
				headers: { 'cache-control': 'no-store' }
			}
		);
	}
}
