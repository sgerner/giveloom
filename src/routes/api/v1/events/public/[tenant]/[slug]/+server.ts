import { json } from '@sveltejs/kit';
import { publicEvent, addPublicRegistration, EventError } from '$lib/server/event-management';
import { authRateLimit } from '$lib/server/auth-rate-limit';
import { StripePaymentProvider } from '$lib/providers/stripe';
import { env } from '$env/dynamic/private';
import { randomUUID } from 'node:crypto';
import { getPool } from '$lib/server/database';
export async function GET({ params }) {
	try {
		const result = await publicEvent(params.tenant, params.slug);
		if (!result)
			return json(
				{ error: 'Event not found.' },
				{ status: 404, headers: { 'cache-control': 'no-store' } }
			);
		return json(result, {
			headers: { 'cache-control': 'public, max-age=30, stale-while-revalidate=30' }
		});
	} catch {
		return json({ error: 'Event not found.' }, { status: 404 });
	}
}
export async function POST({ params, request, getClientAddress }) {
	try {
		const rate = await authRateLimit('event-registration', getClientAddress(), 10, 600);
		if (!rate.available)
			return json(
				{ error: 'Registration protection is temporarily unavailable.' },
				{ status: 503 }
			);
		if (!rate.allowed)
			return json({ error: 'Too many registration attempts. Try again shortly.' }, { status: 429 });
		const body = await request.json();
		const requestKey =
			typeof body?.requestKey === 'string' ? body.requestKey : randomUUID() + randomUUID();
		const registration = await addPublicRegistration(params.tenant, params.slug, {
			...body,
			requestKey
		});
		if (Number(registration.amountMinor) === 0)
			return json(
				{
					id: registration.id,
					status: registration.status,
					publicRef: registration.publicRef || undefined
				},
				{ status: 201, headers: { 'cache-control': 'no-store' } }
			);
		if (!env.DATABASE_URL || !env.STRIPE_PLATFORM_SECRET_KEY || !env.STRIPE_CONNECT_PUBLISHABLE_KEY)
			throw new EventError('Paid event registration is not configured.', 503);
		const activeTenant = await getPool().query(
			'SELECT id FROM tenants WHERE slug=$1 AND suspended_at IS NULL',
			[params.tenant]
		);
		if (!activeTenant.rowCount) throw new EventError('Event registration is unavailable.', 404);
		const publishableLive = env.STRIPE_CONNECT_PUBLISHABLE_KEY.startsWith('pk_live_');
		if (
			!/^pk_(live|test)_[A-Za-z0-9]+$/.test(env.STRIPE_CONNECT_PUBLISHABLE_KEY) ||
			publishableLive !== env.STRIPE_PLATFORM_SECRET_KEY.startsWith('sk_live_')
		)
			throw new EventError('Stripe payment configuration is unavailable.', 503);
		const provider = new StripePaymentProvider(env.STRIPE_PLATFORM_SECRET_KEY);
		const common = {
			tenantId: activeTenant.rows[0].id,
			connectedAccountId: registration.stripeAccountId,
			amount: {
				amountMinor: Number(registration.amountMinor),
				currency: String(registration.currency).trim().toUpperCase()
			},
			idempotencyKey: `event-ticket:${registration.id}`,
			metadata: { event_registration_id: registration.id, event_ticket_type_id: body.ticketTypeId }
		};
		if (!common.tenantId || !common.connectedAccountId)
			throw new EventError('Paid event registration is not available.', 503);
		let payment;
		if (
			registration.existing &&
			registration.stripePaymentIntentId &&
			provider.retrieveIntentSecret
		) {
			const clientSecret = await provider.retrieveIntentSecret({
				connectedAccountId: common.connectedAccountId,
				providerIntentId: registration.stripePaymentIntentId
			});
			payment = { clientSecret, providerIntentId: registration.stripePaymentIntentId };
		} else payment = await provider.createIntent(common);
		if (!registration.stripePaymentIntentId)
			await (
				await import('$lib/server/event-management')
			).attachTicketPayment(params.tenant, registration.id, payment.providerIntentId);
		return json(
			{
				id: registration.id,
				status: 'pending_payment',
				amountMinor: registration.amountMinor,
				currency: registration.currency,
				clientSecret: payment.clientSecret,
				publishableKey: env.STRIPE_CONNECT_PUBLISHABLE_KEY,
				connectedAccountId: common.connectedAccountId,
				publicRef: registration.publicRef || undefined
			},
			{ status: 201, headers: { 'cache-control': 'no-store' } }
		);
	} catch (error) {
		return json(
			{ error: error instanceof Error ? error.message : 'Registration could not be completed.' },
			{
				status: Number((error as { status?: number })?.status) || 400,
				headers: { 'cache-control': 'no-store' }
			}
		);
	}
}
