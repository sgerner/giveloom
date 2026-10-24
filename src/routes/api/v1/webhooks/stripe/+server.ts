import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import Stripe from 'stripe';
import { PaymentError, processStripeEvent } from '$lib/server/payments';

export async function POST({ request }) {
	const signature = request.headers.get('stripe-signature');
	if (!env.STRIPE_CONNECT_WEBHOOK_SECRET || !env.STRIPE_PLATFORM_SECRET_KEY)
		return json({ error: 'Stripe webhook verification is not configured.' }, { status: 503 });
	if (!signature || signature.length > 2048)
		return json({ error: 'Stripe signature is missing or invalid.' }, { status: 400 });
	const contentLength = Number(request.headers.get('content-length') || 0);
	if (contentLength > 2_000_000)
		return json({ error: 'Stripe event payload is too large.' }, { status: 413 });
	const rawBody = await request.text();
	if (Buffer.byteLength(rawBody, 'utf8') > 2_000_000)
		return json({ error: 'Stripe event payload is too large.' }, { status: 413 });
	try {
		const stripe = new Stripe(env.STRIPE_PLATFORM_SECRET_KEY);
		const event = stripe.webhooks.constructEvent(
			rawBody,
			signature,
			env.STRIPE_CONNECT_WEBHOOK_SECRET
		);
		const result = await processStripeEvent(event, rawBody);
		return json(
			{ received: true, duplicate: result.duplicate },
			{ headers: { 'cache-control': 'no-store' } }
		);
	} catch (error) {
		if (error instanceof Stripe.errors.StripeSignatureVerificationError)
			return json({ error: 'Stripe signature verification failed.' }, { status: 400 });
		const status = error instanceof PaymentError ? error.status : 503;
		return json(
			{
				error:
					error instanceof PaymentError
						? error.message
						: 'Stripe event could not be processed; provider retry is required.'
			},
			{ status, headers: { 'cache-control': 'no-store' } }
		);
	}
}
