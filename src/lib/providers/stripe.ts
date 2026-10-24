import Stripe from 'stripe';
import type {
	PaymentIntentInput,
	PaymentIntentResult,
	PaymentProvider,
	ProviderDescriptor
} from './types';
import { ProviderUnavailableError } from './types';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Creates PaymentIntents for a tenant's already-authorized Stripe Connect account. */
export class StripePaymentProvider implements PaymentProvider {
	private readonly client?: Stripe;
	readonly descriptor: ProviderDescriptor;

	constructor(apiKey = process.env.STRIPE_PLATFORM_SECRET_KEY) {
		if (apiKey) this.client = new Stripe(apiKey);
		const mode = apiKey?.startsWith('sk_test_')
			? 'test'
			: apiKey?.startsWith('sk_live_')
				? 'production'
				: 'disabled';
		this.descriptor = {
			provider: 'stripe-connect',
			mode,
			capabilities: {
				api: mode !== 'disabled',
				bulkCsv: false,
				incrementalUpdates: false,
				geographicCoverage: [],
				pricing: 'usage-based',
				licenseFlags: ['stripe-connected-account-required']
			}
		};
	}

	async createIntent(input: PaymentIntentInput): Promise<PaymentIntentResult> {
		if (!this.client)
			throw new ProviderUnavailableError('Stripe', 'STRIPE_PLATFORM_SECRET_KEY is not configured');
		if (!UUID.test(input.tenantId)) throw new TypeError('tenantId must be a UUID');
		if (!/^acct_[A-Za-z0-9]+$/.test(input.connectedAccountId))
			throw new TypeError('connectedAccountId must be a Stripe Connect account ID');
		if (!Number.isSafeInteger(input.amount.amountMinor) || input.amount.amountMinor < 1)
			throw new RangeError('amountMinor must be a positive integer');
		if (!/^[A-Z]{3}$/.test(input.amount.currency))
			throw new TypeError('currency must be an uppercase ISO 4217 code');
		if (!input.idempotencyKey || input.idempotencyKey.length > 255)
			throw new TypeError('idempotencyKey must be 1–255 characters');
		const metadata = Object.fromEntries(
			Object.entries(input.metadata ?? {}).filter(
				([key, value]) => /^[a-zA-Z0-9_]{1,40}$/.test(key) && value.length <= 500
			)
		);
		try {
			const intent = await this.client.paymentIntents.create(
				{
					amount: input.amount.amountMinor,
					currency: input.amount.currency.toLowerCase(),
					...(input.donorEmail ? { receipt_email: input.donorEmail } : {}),
					automatic_payment_methods: { enabled: true },
					metadata: { ...metadata, tenant_id: input.tenantId }
				},
				{ stripeAccount: input.connectedAccountId, idempotencyKey: input.idempotencyKey }
			);
			if (!intent.client_secret) throw new Error('Stripe returned no client secret');
			const status = intent.status;
			if (
				![
					'requires_payment_method',
					'requires_action',
					'processing',
					'succeeded',
					'canceled'
				].includes(status)
			) {
				throw new Error(`Stripe returned an unsupported PaymentIntent state: ${status}`);
			}
			return {
				providerIntentId: intent.id,
				clientSecret: intent.client_secret,
				status: status as PaymentIntentResult['status']
			};
		} catch (error) {
			const stripeError = error as { type?: string; code?: string };
			const details = [stripeError.type, stripeError.code].filter(Boolean).join(', ');
			throw new Error(`Stripe PaymentIntent creation failed${details ? ` (${details})` : ''}`);
		}
	}

	async createRecurringIntent(
		input: PaymentIntentInput
	): Promise<PaymentIntentResult & { providerSubscriptionId: string; providerCustomerId: string }> {
		if (!this.client)
			throw new ProviderUnavailableError('Stripe', 'STRIPE_PLATFORM_SECRET_KEY is not configured');
		if (!input.donorEmail || !input.donorName)
			throw new TypeError('Recurring donations require donor identity');
		if (input.frequency !== 'monthly' && input.frequency !== 'annual')
			throw new TypeError('Recurring frequency must be monthly or annual');
		const account = input.connectedAccountId;
		try {
			const customer = await this.client.customers.create(
				{ email: input.donorEmail, name: input.donorName, metadata: { tenant_id: input.tenantId } },
				{ stripeAccount: account, idempotencyKey: `${input.idempotencyKey}:customer` }
			);
			const product = await this.client.products.create(
				{ name: 'Donation', metadata: { tenant_id: input.tenantId } },
				{ stripeAccount: account, idempotencyKey: `${input.idempotencyKey}:product` }
			);
			const subscription = await this.client.subscriptions.create(
				{
					customer: customer.id,
					items: [
						{
							price_data: {
								currency: input.amount.currency.toLowerCase(),
								unit_amount: input.amount.amountMinor,
								product: product.id,
								recurring: { interval: input.frequency === 'monthly' ? 'month' : 'year' }
							}
						}
					],
					payment_behavior: 'default_incomplete',
					payment_settings: { save_default_payment_method: 'on_subscription' },
					metadata: { ...input.metadata, tenant_id: input.tenantId },
					expand: ['latest_invoice.confirmation_secret']
				},
				{ stripeAccount: account, idempotencyKey: `${input.idempotencyKey}:subscription` }
			);
			const invoice = subscription.latest_invoice as unknown as {
				confirmation_secret?: { client_secret?: string };
				payment_intent?: { client_secret?: string; status?: string };
			} | null;
			const clientSecret =
				invoice?.confirmation_secret?.client_secret || invoice?.payment_intent?.client_secret;
			if (!clientSecret) throw new Error('Stripe returned no initial invoice confirmation secret');
			const status = invoice?.payment_intent?.status || 'requires_action';
			return {
				providerIntentId: invoice?.payment_intent
					? (invoice.payment_intent as { id?: string }).id || ''
					: '',
				providerSubscriptionId: subscription.id,
				providerCustomerId: customer.id,
				clientSecret,
				status: [
					'requires_payment_method',
					'requires_action',
					'processing',
					'succeeded',
					'canceled'
				].includes(status)
					? (status as PaymentIntentResult['status'])
					: 'requires_action'
			};
		} catch (error) {
			const stripeError = error as { type?: string; code?: string };
			const details = [stripeError.type, stripeError.code].filter(Boolean).join(', ');
			throw new Error(`Stripe recurring donation setup failed${details ? ` (${details})` : ''}`);
		}
	}

	async retrieveIntentSecret(input: { connectedAccountId: string; providerIntentId: string }) {
		if (!this.client)
			throw new ProviderUnavailableError('Stripe', 'STRIPE_PLATFORM_SECRET_KEY is not configured');
		const intent = await this.client.paymentIntents.retrieve(input.providerIntentId, {
			stripeAccount: input.connectedAccountId
		});
		if (!intent.client_secret) throw new Error('Stripe returned no PaymentIntent client secret');
		return intent.client_secret;
	}

	async retrieveRecurringSecret(input: {
		connectedAccountId: string;
		providerSubscriptionId: string;
	}) {
		if (!this.client)
			throw new ProviderUnavailableError('Stripe', 'STRIPE_PLATFORM_SECRET_KEY is not configured');
		const subscription = await this.client.subscriptions.retrieve(
			input.providerSubscriptionId,
			{ expand: ['latest_invoice.confirmation_secret'] },
			{ stripeAccount: input.connectedAccountId }
		);
		const invoice = subscription.latest_invoice as unknown as {
			confirmation_secret?: { client_secret?: string };
			payment_intent?: { client_secret?: string };
		} | null;
		const clientSecret =
			invoice?.confirmation_secret?.client_secret || invoice?.payment_intent?.client_secret;
		if (!clientSecret) throw new Error('Stripe returned no invoice confirmation secret');
		return clientSecret;
	}
}
