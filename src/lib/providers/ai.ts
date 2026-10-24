import type { AIProvider, AIRequest, AIResponse, ProviderDescriptor } from './types';
import { ProviderUnavailableError } from './types';

const DEFAULT_ENDPOINT = 'https://api.openai.com/v1/responses';

/** OpenAI Responses API adapter. Tenant keys are request-scoped and are never retained. */
export class OpenAIResponsesProvider implements AIProvider {
	readonly descriptor: ProviderDescriptor = {
		provider: 'openai-responses',
		mode: 'production',
		capabilities: {
			api: true,
			bulkCsv: false,
			incrementalUpdates: false,
			geographicCoverage: [],
			pricing: 'usage-based',
			licenseFlags: ['tenant-key-required', 'per-request-budget-required']
		}
	};

	constructor(
		private readonly options: {
			endpoint?: string;
			maxInputCharacters?: number;
			maxOutputTokens?: number;
			fetcher?: typeof fetch;
			timeoutMs?: number;
		} = {}
	) {
		const endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
		const parsed = new URL(endpoint);
		if (
			parsed.protocol !== 'https:' ||
			parsed.hostname !== 'api.openai.com' ||
			parsed.pathname !== '/v1/responses'
		)
			throw new TypeError('AI endpoint must be the OpenAI Responses API over HTTPS');
	}

	async complete(request: AIRequest): Promise<AIResponse> {
		if (!request.apiKey || request.apiKey.length > 512)
			throw new ProviderUnavailableError('OpenAI', 'a tenant API key is required');
		if (!request.tenantId || !request.model) throw new TypeError('tenantId and model are required');
		const maxInput = this.options.maxInputCharacters ?? 24_000;
		const maxOutput = this.options.maxOutputTokens ?? 1_000;
		if (!Number.isSafeInteger(maxOutput) || maxOutput < 1 || maxOutput > 4_000)
			throw new RangeError('maxOutputTokens must be between 1 and 4000');
		if (request.system.length + request.user.length > maxInput)
			throw new RangeError(`AI input exceeds the ${maxInput} character request budget`);
		const endpoint = this.options.endpoint ?? DEFAULT_ENDPOINT;
		const fetcher = this.options.fetcher ?? fetch;
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 30_000);
		try {
			const response = await fetcher(endpoint, {
				method: 'POST',
				headers: { authorization: `Bearer ${request.apiKey}`, 'content-type': 'application/json' },
				body: JSON.stringify({
					model: request.model,
					instructions: request.system,
					input: request.user,
					max_output_tokens: maxOutput
				}),
				signal: controller.signal
			});
			if (!response.ok)
				throw new ProviderResponseError(
					`OpenAI Responses request failed with HTTP ${response.status}`
				);
			const payload = (await response.json()) as {
				output_text?: unknown;
				output?: Array<{ type?: unknown; content?: Array<{ type?: unknown; text?: unknown }> }>;
				model?: unknown;
				usage?: { input_tokens?: unknown; output_tokens?: unknown };
			};
			const outputText =
				typeof payload.output_text === 'string'
					? payload.output_text
					: payload.output
							?.flatMap((item) => (item.type === 'message' ? (item.content ?? []) : []))
							.filter((item) => item.type === 'output_text' && typeof item.text === 'string')
							.map((item) => item.text as string)
							.join('');
			if (typeof outputText !== 'string' || typeof payload.model !== 'string')
				throw new Error('OpenAI returned an invalid Responses payload');
			return {
				text: outputText,
				model: payload.model,
				...(typeof payload.usage?.input_tokens === 'number'
					? { inputTokens: payload.usage.input_tokens }
					: {}),
				...(typeof payload.usage?.output_tokens === 'number'
					? { outputTokens: payload.usage.output_tokens }
					: {})
			};
		} catch (error) {
			if (error instanceof RangeError || error instanceof ProviderUnavailableError) throw error;
			if (error instanceof ProviderResponseError) throw error;
			throw new Error(
				`OpenAI Responses request failed: ${error instanceof Error && error.name === 'AbortError' ? 'timeout' : 'network or provider error'}`
			);
		} finally {
			clearTimeout(timeout);
		}
	}
}

class ProviderResponseError extends Error {}
