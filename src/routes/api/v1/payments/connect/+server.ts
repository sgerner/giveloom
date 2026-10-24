import { json, redirect } from '@sveltejs/kit';
import { randomBytes } from 'node:crypto';
import { env } from '$env/dynamic/private';
import {
	stripeAccountStatus,
	createStripeConnectState,
	disconnectStripeAccount,
	PaymentError,
	stripeClient
} from '$lib/server/payments';
import { consumeStripeConnectState, saveStripeAccount } from '$lib/server/payments';

function requireManager(session: App.Locals['session']) {
	if (!session) throw new PaymentError('Sign in before managing Stripe.', 401);
	if (session.demo) throw new PaymentError('Demo mode cannot connect a live payment account.', 403);
	return session as App.Locals['session'] & { tenantSlug: string; userId: string };
}
export async function GET({ locals }) {
	try {
		const session = requireManager(locals.session);
		const status = await stripeAccountStatus(session);
		return json(
			{ ...status, canManage: ['owner', 'admin'].includes(status.role) },
			{ headers: { 'cache-control': 'private, no-store' } }
		);
	} catch (error) {
		return json(
			{
				error: error instanceof PaymentError ? error.message : 'Stripe is temporarily unavailable.'
			},
			{ status: (error as PaymentError).status || 503 }
		);
	}
}
export async function POST({ locals, url }) {
	try {
		const session = requireManager(locals.session);
		if (!['owner', 'admin'].includes(session.role))
			throw new PaymentError('Only a workspace owner or admin can connect Stripe.', 403);
		const clientId = env.STRIPE_CONNECT_CLIENT_ID;
		if (!clientId || !env.STRIPE_PLATFORM_SECRET_KEY)
			throw new PaymentError('Stripe Connect is not configured by the platform operator.', 503);
		const state = randomBytes(32).toString('base64url');
		await createStripeConnectState(session, state);
		const callback = new URL('/api/v1/payments/connect/callback', url.origin).toString();
		const authorize = new URL('https://connect.stripe.com/oauth/authorize');
		authorize.searchParams.set('response_type', 'code');
		authorize.searchParams.set('client_id', clientId);
		authorize.searchParams.set('scope', 'read_write');
		authorize.searchParams.set('redirect_uri', callback);
		authorize.searchParams.set('state', state);
		throw redirect(303, authorize.toString());
	} catch (error) {
		if ((error as { status?: number }).status === 303) throw error;
		return json(
			{
				error: error instanceof PaymentError ? error.message : 'Stripe connection could not start.'
			},
			{ status: (error as PaymentError).status || 503 }
		);
	}
}
export async function DELETE({ locals }) {
	try {
		const session = requireManager(locals.session);
		if (!['owner', 'admin'].includes(session.role))
			throw new PaymentError('Only a workspace owner or admin can disconnect Stripe.', 403);
		const clientId = env.STRIPE_CONNECT_CLIENT_ID;
		if (!clientId)
			throw new PaymentError('Stripe Connect is not configured by the platform operator.', 503);
		const connectedAccountId = await stripeAccountStatus(session);
		if (connectedAccountId.accountId && connectedAccountId.connected) {
			await stripeClient().oauth.deauthorize({
				client_id: clientId,
				stripe_user_id: connectedAccountId.accountId
			});
		}
		await disconnectStripeAccount(session);
		return json(
			{ ok: true, connected: false },
			{ headers: { 'cache-control': 'private, no-store' } }
		);
	} catch (error) {
		return json(
			{
				error:
					error instanceof PaymentError
						? error.message
						: 'Stripe disconnect could not be completed.'
			},
			{ status: (error as PaymentError).status || 503 }
		);
	}
}
