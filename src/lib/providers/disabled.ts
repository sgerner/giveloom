import {
	disabledDescriptor,
	ProviderUnavailableError,
	type AIProvider,
	type AIRequest,
	type EmailMessage,
	type OutboundEmailProvider,
	type PaymentIntentInput,
	type PaymentProvider,
	type ResearchProvider,
	type ResearchQuery
} from './types';

/** Fail closed until a vendor implementation, tenant authorization, and credentials are configured. */
export class DisabledPaymentProvider implements PaymentProvider {
	readonly descriptor = disabledDescriptor('payment');
	async createIntent(_input: PaymentIntentInput): ReturnType<PaymentProvider['createIntent']> {
		throw new ProviderUnavailableError('payment', 'no production adapter is configured');
	}
}

export class DisabledOutboundEmailProvider implements OutboundEmailProvider {
	readonly descriptor = disabledDescriptor('outbound email');
	async send(_message: EmailMessage): ReturnType<OutboundEmailProvider['send']> {
		throw new ProviderUnavailableError('outbound email', 'no production adapter is configured');
	}
}

export class DisabledResearchProvider implements ResearchProvider {
	readonly descriptor = disabledDescriptor('research');
	async search(_query: ResearchQuery): ReturnType<ResearchProvider['search']> {
		throw new ProviderUnavailableError('research', 'no licensed source adapter is configured');
	}
}

export class DisabledAIProvider implements AIProvider {
	readonly descriptor = disabledDescriptor('ai');
	async complete(_request: AIRequest): ReturnType<AIProvider['complete']> {
		throw new ProviderUnavailableError(
			'ai',
			'no tenant API-key adapter is configured; Codex device-code mode is disabled'
		);
	}
}
