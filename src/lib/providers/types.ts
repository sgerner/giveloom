export type CapabilityManifest = {
	api: boolean;
	bulkCsv: boolean;
	incrementalUpdates: boolean;
	geographicCoverage: string[];
	pricing: 'free' | 'usage-based' | 'subscription' | 'unknown';
	licenseFlags: string[];
};

export type ProviderDescriptor = {
	provider: string;
	mode: 'production' | 'test' | 'disabled';
	capabilities: CapabilityManifest;
};

export type Money = { amountMinor: number; currency: string };

export type PaymentIntentInput = {
	tenantId: string;
	connectedAccountId: string;
	amount: Money;
	idempotencyKey: string;
	metadata?: Record<string, string>;
	frequency?: 'once' | 'monthly' | 'annual';
	donorEmail?: string;
	donorName?: string;
};

export type PaymentIntentResult = {
	providerIntentId: string;
	clientSecret: string;
	status: 'requires_payment_method' | 'requires_action' | 'processing' | 'succeeded' | 'canceled';
};

export interface PaymentProvider {
	readonly descriptor: ProviderDescriptor;
	createIntent(input: PaymentIntentInput): Promise<PaymentIntentResult>;
	createRecurringIntent?(
		input: PaymentIntentInput
	): Promise<PaymentIntentResult & { providerSubscriptionId: string; providerCustomerId: string }>;
	retrieveIntentSecret?(input: {
		connectedAccountId: string;
		providerIntentId: string;
	}): Promise<string>;
	retrieveRecurringSecret?(input: {
		connectedAccountId: string;
		providerSubscriptionId: string;
	}): Promise<string>;
}

export type EmailMessage = {
	tenantId: string;
	to: string;
	from: string;
	subject: string;
	text: string;
	html?: string;
	idempotencyKey: string;
};

export type EmailSendResult = { providerMessageId: string; acceptedAt: string };

export interface OutboundEmailProvider {
	readonly descriptor: ProviderDescriptor;
	send(message: EmailMessage): Promise<EmailSendResult>;
}

export type ResearchQuery = {
	missionKeywords: string[];
	geography?: string;
	limit: number;
};

export type ResearchRecord = {
	name: string;
	recordType: 'person' | 'organization' | 'foundation';
	sourceName: string;
	sourceUrl: string;
	observedAt: string;
	license: string;
	evidence: string;
};

export interface ResearchProvider {
	readonly descriptor: ProviderDescriptor;
	search(query: ResearchQuery): Promise<ResearchRecord[]>;
}

export type AIRequest = {
	tenantId: string;
	apiKey: string;
	model: string;
	system: string;
	user: string;
};

export type AIResponse = {
	text: string;
	model: string;
	inputTokens?: number;
	outputTokens?: number;
};

export interface AIProvider {
	readonly descriptor: ProviderDescriptor;
	complete(request: AIRequest): Promise<AIResponse>;
}

export type BlobObject = {
	tenantId: string;
	objectId: string;
	mediaType: string;
	bytes: Uint8Array;
};

export type BlobPutInput = {
	tenantId: string;
	bytes: Uint8Array;
	mediaType: string;
	originalName: string;
};

export interface BlobStorage {
	readonly descriptor: ProviderDescriptor;
	put(input: BlobPutInput): Promise<{ objectId: string }>;
	get(input: Pick<BlobObject, 'tenantId' | 'objectId'>): Promise<BlobObject>;
	delete(input: Pick<BlobObject, 'tenantId' | 'objectId'>): Promise<void>;
	signedDownload(input: {
		tenantId: string;
		objectId: string;
		expiresInSeconds: number;
	}): Promise<string>;
}

export class ProviderUnavailableError extends Error {
	constructor(provider: string, reason: string) {
		super(`${provider} provider unavailable: ${reason}`);
		this.name = 'ProviderUnavailableError';
	}
}

export const disabledDescriptor = (provider: string): ProviderDescriptor => ({
	provider,
	mode: 'disabled',
	capabilities: {
		api: false,
		bulkCsv: false,
		incrementalUpdates: false,
		geographicCoverage: [],
		pricing: 'unknown',
		licenseFlags: ['unconfigured']
	}
});
