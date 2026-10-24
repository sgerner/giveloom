import { randomUUID } from 'node:crypto';
import type {
	AIProvider,
	BlobPutInput,
	BlobStorage,
	CapabilityManifest,
	EmailMessage,
	OutboundEmailProvider,
	PaymentIntentInput,
	PaymentProvider,
	ProviderDescriptor,
	ResearchProvider,
	ResearchQuery,
	ResearchRecord
} from './types';

const testDescriptor = (
	provider: string,
	extra: Partial<CapabilityManifest> = {}
): ProviderDescriptor => ({
	provider,
	mode: 'test',
	capabilities: {
		api: true,
		bulkCsv: false,
		incrementalUpdates: false,
		geographicCoverage: [],
		pricing: 'free',
		licenseFlags: ['test-only', 'synthetic-data'],
		...extra
	}
});

/** Fixture adapter. Import only from tests or an explicitly isolated demo harness. */
export class FakePaymentProvider implements PaymentProvider {
	readonly descriptor = testDescriptor('fake-payment');
	async createIntent(input: PaymentIntentInput) {
		return {
			providerIntentId: `test_${input.idempotencyKey}`,
			clientSecret: `test_secret_${input.idempotencyKey}`,
			status: 'succeeded' as const
		};
	}
}

export class FakeOutboundEmailProvider implements OutboundEmailProvider {
	readonly descriptor = testDescriptor('fake-email');
	readonly sent: EmailMessage[] = [];
	async send(message: EmailMessage) {
		this.sent.push(structuredClone(message));
		return { providerMessageId: `test_${randomUUID()}`, acceptedAt: new Date().toISOString() };
	}
}

export class FakeResearchProvider implements ResearchProvider {
	readonly descriptor = testDescriptor('fixture-research', {
		licenseFlags: ['test-only', 'synthetic-data', 'no-outreach']
	});
	async search(query: ResearchQuery): Promise<ResearchRecord[]> {
		if (query.limit < 1) return [];
		return [
			{
				name: 'Example Foundation',
				recordType: 'foundation',
				sourceName: 'Synthetic fixture',
				sourceUrl: 'https://example.invalid/fixture',
				observedAt: '2026-01-01T00:00:00.000Z',
				license: 'synthetic-only',
				evidence: `Fixture result for ${query.missionKeywords.join(', ')}`
			}
		];
	}
}

export class FakeAIProvider {
	readonly descriptor = testDescriptor('fake-ai');
	async complete(request: {
		tenantId: string;
		apiKey: string;
		model: string;
		system: string;
		user: string;
	}) {
		return {
			text: `Synthetic response for tenant ${request.tenantId}`,
			model: request.model,
			inputTokens: 1,
			outputTokens: 1
		};
	}
}

export class FakeBlobStorage implements BlobStorage {
	readonly descriptor = testDescriptor('fake-blob');
	private readonly objects = new Map<
		string,
		{ tenantId: string; mediaType: string; bytes: Uint8Array }
	>();
	async put(input: BlobPutInput) {
		const objectId = randomUUID();
		this.objects.set(objectId, {
			tenantId: input.tenantId,
			mediaType: input.mediaType,
			bytes: new Uint8Array(input.bytes)
		});
		return { objectId };
	}
	async get(input: { tenantId: string; objectId: string }) {
		const stored = this.objects.get(input.objectId);
		if (!stored || stored.tenantId !== input.tenantId) throw new Error('Object not found');
		return { ...input, mediaType: stored.mediaType, bytes: new Uint8Array(stored.bytes) };
	}
	async delete(input: { tenantId: string; objectId: string }) {
		const stored = this.objects.get(input.objectId);
		if (stored && stored.tenantId !== input.tenantId) throw new Error('Object not found');
		this.objects.delete(input.objectId);
	}
	async signedDownload(input: { tenantId: string; objectId: string; expiresInSeconds: number }) {
		await this.get(input);
		return `test://download/${encodeURIComponent(input.tenantId)}/${encodeURIComponent(input.objectId)}?ttl=${input.expiresInSeconds}`;
	}
}
