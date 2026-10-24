import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { env } from '$env/dynamic/private';
import { StripePaymentProvider } from '$lib/providers/stripe';
import type { PaymentIntentResult } from '$lib/providers/types';
import { authRateLimit } from '$lib/server/auth-rate-limit';
import {
	createDonationRequest,
	failStripeIntent,
	makeCheckoutToken,
	PaymentError,
	saveStripeIntent
} from '$lib/server/payments';
import { readLimitedBody } from '$lib/server/request';
import { getPool } from '$lib/server/database';

const schema = z
	.object({
		tenant: z
			.string()
			.min(1)
			.max(80)
			.regex(/^[a-z0-9-]+$/),
		campaignId: z.string().uuid().optional(),
		fundraiserId: z.string().uuid().optional(),
		campaignLinkCode: z
			.string()
			.min(6)
			.max(32)
			.regex(/^[A-Za-z0-9_-]+$/)
			.optional(),
		requestKey: z
			.string()
			.min(16)
			.max(128)
			.regex(/^[A-Za-z0-9._-]+$/),
		amountMinor: z.number().int().min(50).max(25_000_000),
		frequency: z.enum(['once', 'monthly', 'annual']).default('once'),
		donorName: z.string().trim().min(1).max(120),
		donorEmail: z.string().trim().email().max(254),
		termsAccepted: z.literal(true),
		anonymous: z.boolean().optional(),
		feeCoverage: z.boolean().optional(),
		designationFundId: z.string().uuid().optional(),
		address: z
			.object({
				line1: z.string().trim().min(1).max(120),
				line2: z.string().trim().max(120).optional(),
				city: z.string().trim().min(1).max(100),
				region: z.string().trim().min(1).max(100),
				postalCode: z.string().trim().min(1).max(24),
				country: z.string().regex(/^[A-Za-z]{2}$/)
			})
			.strict()
			.optional(),
		tribute: z
			.object({
				kind: z.enum(['honor', 'memory']),
				honoree: z.string().trim().min(2).max(120),
				notifyName: z.string().trim().max(120).optional(),
				notifyEmail: z.string().trim().email().max(254).optional()
			})
			.strict()
			.optional(),
		utm: z
			.object({
				source: z.string().max(80).optional(),
				medium: z.string().max(80).optional(),
				campaign: z.string().max(80).optional(),
				content: z.string().max(80).optional(),
				term: z.string().max(80).optional()
			})
			.strict()
			.optional()
	})
	.strict();

export async function POST({ request, getClientAddress }) {
	if (!env.DATABASE_URL || !env.STRIPE_PLATFORM_SECRET_KEY || !env.STRIPE_CONNECT_PUBLISHABLE_KEY)
		return json({ error: 'Online donations are not configured.' }, { status: 503 });
	const publishableLive = env.STRIPE_CONNECT_PUBLISHABLE_KEY.startsWith('pk_live_');
	if (
		!env.STRIPE_CONNECT_PUBLISHABLE_KEY.match(/^pk_(live|test)_[A-Za-z0-9]+$/) ||
		publishableLive !== env.STRIPE_PLATFORM_SECRET_KEY.startsWith('sk_live_')
	)
		return json(
			{ error: 'Stripe publishable and secret key modes do not match.' },
			{ status: 503 }
		);
	const rate = await authRateLimit('donation', getClientAddress(), 8, 600);
	if (!rate.available)
		return json({ error: 'Donation protection is temporarily unavailable.' }, { status: 503 });
	if (!rate.allowed)
		return json(
			{ error: 'Too many donation attempts. Try again in a few minutes.' },
			{ status: 429 }
		);
	let input: z.infer<typeof schema>;
	try {
		input = schema.parse(JSON.parse(await readLimitedBody(request, 16_000)));
	} catch (error) {
		return json(
			{
				error:
					error instanceof RangeError
						? 'Donation request is too large.'
						: 'Provide a valid workspace, amount, donor name, and email.'
			},
			{ status: error instanceof RangeError ? 413 : 400 }
		);
	}
	try {
		const created = await createDonationRequest({
			...input,
			donorEmail: input.donorEmail.toLowerCase()
		});
		const stillActive = await getPool().query(
			'SELECT 1 FROM tenants WHERE id=$1 AND suspended_at IS NULL',
			[created.tenant.id]
		);
		if (!stillActive.rowCount)
			throw new PaymentError('Donations are unavailable for this workspace.', 404);
		const provider = new StripePaymentProvider(env.STRIPE_PLATFORM_SECRET_KEY);
		if (created.existing) {
			const row = created.row;
			if (['failed', 'canceled', 'ended'].includes(row.status))
				throw new PaymentError(
					'This donation attempt cannot be resumed. Start a new attempt.',
					409
				);
			if (row.stripe_subscription_id && provider.retrieveRecurringSecret) {
				const clientSecret = await provider.retrieveRecurringSecret({
					connectedAccountId: created.connectedAccountId,
					providerSubscriptionId: row.stripe_subscription_id
				});
				return json(
					{
						clientSecret,
						publishableKey: env.STRIPE_CONNECT_PUBLISHABLE_KEY,
						connectedAccountId: created.connectedAccountId,
						checkoutToken: makeCheckoutToken(created.tenant.id, row.id),
						frequency: row.frequency,
						amountMinor: Number(row.amount_minor),
						currency: created.currency
					},
					{ headers: { 'cache-control': 'no-store' } }
				);
			}
			if (row.stripe_payment_intent_id && provider.retrieveIntentSecret) {
				const clientSecret = await provider.retrieveIntentSecret({
					connectedAccountId: created.connectedAccountId,
					providerIntentId: row.stripe_payment_intent_id
				});
				return json(
					{
						clientSecret,
						publishableKey: env.STRIPE_CONNECT_PUBLISHABLE_KEY,
						connectedAccountId: created.connectedAccountId,
						checkoutToken: makeCheckoutToken(created.tenant.id, row.id),
						frequency: row.frequency,
						amountMinor: Number(row.amount_minor),
						currency: created.currency
					},
					{ headers: { 'cache-control': 'no-store' } }
				);
			}
			throw new PaymentError(
				'This donation request is still being prepared. Retry shortly with the same request key.',
				409
			);
		}
		const row = created.row;
		const stripeKey = `donation:${created.tenant.id}:${row.request_key_hash}`;
		const common = {
			tenantId: created.tenant.id,
			connectedAccountId: created.connectedAccountId,
			amount: { amountMinor: Number(row.amount_minor), currency: created.currency },
			idempotencyKey: stripeKey,
			metadata: {
				donation_intent_id: row.id,
				campaign_id: input.campaignId || '',
				fund_id: row.fund_id || '',
				fundraising_page_id: row.fundraising_page_id || '',
				campaign_link_code: input.campaignLinkCode || ''
			},
			frequency: input.frequency,
			donorEmail: input.donorEmail.toLowerCase(),
			donorName: input.donorName.trim()
		} as const;
		try {
			let result: PaymentIntentResult;
			let subscriptionId: string | undefined;
			let customerId: string | undefined;
			if (input.frequency === 'once') result = await provider.createIntent(common);
			else {
				const recurring = await provider.createRecurringIntent!(common);
				result = recurring;
				subscriptionId = recurring.providerSubscriptionId;
				customerId = recurring.providerCustomerId;
			}
			await saveStripeIntent(created.tenant.id, row.id, {
				paymentIntentId: result.providerIntentId || undefined,
				subscriptionId,
				customerId,
				status: result.status
			});
			return json(
				{
					clientSecret: result.clientSecret,
					publishableKey: env.STRIPE_CONNECT_PUBLISHABLE_KEY,
					connectedAccountId: created.connectedAccountId,
					checkoutToken: makeCheckoutToken(created.tenant.id, row.id),
					frequency: input.frequency,
					amountMinor: Number(row.amount_minor),
					currency: created.currency
				},
				{ status: 201, headers: { 'cache-control': 'no-store' } }
			);
		} catch (error) {
			await failStripeIntent(created.tenant.id, row.id);
			throw error;
		}
	} catch (error) {
		const status = (error as PaymentError).status || 503;
		return json(
			{
				error:
					error instanceof PaymentError ? error.message : 'Donation setup could not be completed.'
			},
			{ status, headers: { 'cache-control': 'no-store' } }
		);
	}
}
