import { json, redirect } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import {
	consumeStripeConnectState,
	PaymentError,
	platformKey,
	saveStripeAccount
} from '$lib/server/payments';
import Stripe from 'stripe';

export async function GET({ url, locals }) {
	const session = locals.session;
	if (!session || session.demo)
		return json({ error: 'Sign in to finish connecting a payment account.' }, { status: 401 });
	if (url.searchParams.has('error'))
		return json({ error: 'Stripe authorization was declined.' }, { status: 400 });
	const code = url.searchParams.get('code');
	const state = url.searchParams.get('state');
	if (!code || code.length > 4096 || !state || state.length > 128)
		return json({ error: 'Stripe authorization response is incomplete.' }, { status: 400 });
	try {
		const tenant = await consumeStripeConnectState(session, state);
		const clientId = env.STRIPE_CONNECT_CLIENT_ID;
		const key = platformKey();
		if (!clientId || !key)
			throw new PaymentError('Stripe Connect is not configured by the platform operator.', 503);
		const stripe = new Stripe(key);
		const account = await stripe.oauth.token({ grant_type: 'authorization_code', code });
		const connectedAccountId = account.stripe_user_id;
		if (!connectedAccountId || !/^acct_[A-Za-z0-9]+$/.test(connectedAccountId))
			throw new PaymentError('Stripe did not return a valid connected account.', 502);
		if (Boolean(account.livemode) !== key.startsWith('sk_live_'))
			throw new PaymentError('Stripe account mode does not match the platform configuration.', 409);
		await saveStripeAccount(session, connectedAccountId, Boolean(account.livemode));
		throw redirect(
			303,
			`/app/${encodeURIComponent(tenant.slug)}/settings/integrations?stripe=connected`
		);
	} catch (error) {
		if ((error as { status?: number }).status === 303) throw error;
		if (error instanceof Stripe.errors.StripeError)
			return json({ error: 'Stripe authorization could not be completed.' }, { status: 502 });
		return json(
			{
				error:
					error instanceof PaymentError
						? error.message
						: 'Stripe authorization could not be completed.'
			},
			{ status: (error as PaymentError).status || 503 }
		);
	}
}
