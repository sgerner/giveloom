import { createHash, createHmac } from 'node:crypto';
import type {
	EmailMessage,
	EmailSendResult,
	OutboundEmailProvider,
	ProviderDescriptor
} from './types';
import { ProviderUnavailableError } from './types';

type Credentials = { accessKeyId: string; secretAccessKey: string; sessionToken?: string };
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const hmac = (key: Buffer | string, value: string) =>
	createHmac('sha256', key).update(value).digest();

function awsTimestamp(now: Date) {
	return now.toISOString().replace(/[:-]|\.\d{3}/g, '');
}

/** AWS SES v2 SendEmail adapter using SigV4 and ephemeral credentials. */
export class SesEmailProvider implements OutboundEmailProvider {
	readonly descriptor: ProviderDescriptor;
	private readonly credentials?: Credentials;
	private readonly region: string;
	private readonly fromAddress: string;
	private readonly fetcher: typeof fetch;
	private readonly timeoutMs: number;

	constructor(
		options: {
			region?: string;
			fromAddress?: string;
			credentials?: Credentials;
			fetcher?: typeof fetch;
			timeoutMs?: number;
		} = {}
	) {
		this.region = options.region ?? process.env.AWS_REGION ?? '';
		this.fromAddress = options.fromAddress ?? process.env.SES_FROM_ADDRESS ?? '';
		this.credentials =
			options.credentials ??
			(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY
				? {
						accessKeyId: process.env.AWS_ACCESS_KEY_ID,
						secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
						...(process.env.AWS_SESSION_TOKEN
							? { sessionToken: process.env.AWS_SESSION_TOKEN }
							: {})
					}
				: undefined);
		this.fetcher = options.fetcher ?? fetch;
		this.timeoutMs = options.timeoutMs ?? 20_000;
		if (this.region && !/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/.test(this.region))
			throw new TypeError('AWS region is invalid');
		const configured = Boolean(this.region && this.fromAddress && this.credentials);
		this.descriptor = {
			provider: 'aws-ses-v2',
			mode: configured ? 'production' : 'disabled',
			capabilities: {
				api: configured,
				bulkCsv: false,
				incrementalUpdates: false,
				geographicCoverage: this.region ? [this.region] : [],
				pricing: 'usage-based',
				licenseFlags: ['verified-sender-required', 'send-is-not-idempotent-at-provider']
			}
		};
	}

	async send(message: EmailMessage): Promise<EmailSendResult> {
		if (!this.credentials || !this.region || !this.fromAddress)
			throw new ProviderUnavailableError(
				'AWS SES',
				'AWS credentials, AWS_REGION, and SES_FROM_ADDRESS are required'
			);
		if (message.from.toLowerCase() !== this.fromAddress.toLowerCase())
			throw new TypeError('message.from must match the configured verified SES sender');
		if (
			!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(message.to) ||
			!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(message.from)
		)
			throw new TypeError('valid single-recipient email addresses are required');
		if (
			!message.tenantId ||
			!message.idempotencyKey ||
			message.subject.length > 998 ||
			message.text.length > 100_000
		)
			throw new TypeError('email message is missing required data or exceeds provider limits');
		const host = `email.${this.region}.amazonaws.com`;
		const url = `https://${host}/v2/email/outbound-emails`;
		const body = JSON.stringify({
			FromEmailAddress: this.fromAddress,
			Destination: { ToAddresses: [message.to] },
			Content: {
				Simple: {
					Subject: { Data: message.subject, Charset: 'UTF-8' },
					Body: {
						Text: { Data: message.text, Charset: 'UTF-8' },
						...(message.html ? { Html: { Data: message.html, Charset: 'UTF-8' } } : {})
					}
				}
			},
			EmailTags: [
				{ Name: 'tenant_id', Value: message.tenantId.slice(0, 256) },
				{ Name: 'idempotency_key', Value: message.idempotencyKey.slice(0, 256) }
			]
		});
		const now = new Date();
		const amzDate = awsTimestamp(now);
		const date = amzDate.slice(0, 8);
		const payloadHash = sha256(body);
		const headers: Record<string, string> = {
			host,
			'content-type': 'application/json',
			'x-amz-content-sha256': payloadHash,
			'x-amz-date': amzDate,
			...(this.credentials.sessionToken
				? { 'x-amz-security-token': this.credentials.sessionToken }
				: {})
		};
		const signedHeaders = Object.keys(headers).sort().join(';');
		const canonicalHeaders = Object.keys(headers)
			.sort()
			.map((key) => `${key}:${headers[key]?.trim()}\n`)
			.join('');
		const canonicalRequest = [
			'POST',
			'/v2/email/outbound-emails',
			'',
			canonicalHeaders,
			signedHeaders,
			payloadHash
		].join('\n');
		const scope = `${date}/${this.region}/ses/aws4_request`;
		const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${sha256(canonicalRequest)}`;
		const dateKey = hmac(`AWS4${this.credentials.secretAccessKey}`, date);
		const regionKey = hmac(dateKey, this.region);
		const serviceKey = hmac(regionKey, 'ses');
		const signingKey = hmac(serviceKey, 'aws4_request');
		const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');
		headers.authorization = `AWS4-HMAC-SHA256 Credential=${this.credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
		try {
			const response = await this.fetcher(url, {
				method: 'POST',
				headers,
				body,
				signal: controller.signal
			});
			if (!response.ok) throw new Error(`SES send failed with HTTP ${response.status}`);
			const payload = (await response.json()) as { MessageId?: unknown };
			if (typeof payload.MessageId !== 'string' || !payload.MessageId)
				throw new Error('SES returned no message id');
			return { providerMessageId: payload.MessageId, acceptedAt: new Date().toISOString() };
		} catch (error) {
			throw new Error(
				`AWS SES send failed: ${error instanceof Error && error.name === 'AbortError' ? 'timeout; delivery may be uncertain' : error instanceof Error ? error.message : 'provider error'}`
			);
		} finally {
			clearTimeout(timeout);
		}
	}

	/** Read-only SES configuration checks, used before an owner enables sending. */
	async verifySenderIdentity(address = this.fromAddress): Promise<{ verifiedForSending: boolean }> {
		if (!this.credentials || !this.region)
			throw new ProviderUnavailableError('AWS SES', 'AWS credentials and AWS_REGION are required');
		if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address))
			throw new TypeError('valid sender email is required');
		const identity = (await this.signedGet(
			`/v2/email/identities/${encodeURIComponent(address)}`
		)) as { VerifiedForSendingStatus?: unknown };
		return { verifiedForSending: identity.VerifiedForSendingStatus === true };
	}

	/** Read SES identity verification, DKIM, and custom MAIL FROM configuration. */
	async inspectIdentity(identity: string): Promise<{
		verifiedForSending: boolean;
		verificationStatus: string;
		dkimStatus: string;
		dkimEnabled: boolean;
		dkimTokens: string[];
		mailFromDomain: string;
		mailFromStatus: string;
	}> {
		if (!this.credentials || !this.region)
			throw new ProviderUnavailableError('AWS SES', 'AWS credentials and AWS_REGION are required');
		if (!/^(?:[a-z0-9-]+\.)+[a-z]{2,}$/i.test(identity))
			throw new TypeError('valid SES identity domain is required');
		const result = (await this.signedGet(
			`/v2/email/identities/${encodeURIComponent(identity)}`
		)) as {
			VerifiedForSendingStatus?: unknown;
			VerificationStatus?: unknown;
			DkimAttributes?: { Status?: unknown; SigningEnabled?: unknown; Tokens?: unknown };
			MailFromAttributes?: { MailFromDomain?: unknown; MailFromDomainStatus?: unknown };
		};
		const tokens = result.DkimAttributes?.Tokens;
		return {
			verifiedForSending: result.VerifiedForSendingStatus === true,
			verificationStatus:
				typeof result.VerificationStatus === 'string' ? result.VerificationStatus : 'UNKNOWN',
			dkimStatus:
				typeof result.DkimAttributes?.Status === 'string'
					? result.DkimAttributes.Status
					: 'UNKNOWN',
			dkimEnabled: result.DkimAttributes?.SigningEnabled === true,
			dkimTokens: Array.isArray(tokens)
				? tokens
						.filter((item): item is string => typeof item === 'string' && /^[a-z0-9]+$/i.test(item))
						.slice(0, 10)
				: [],
			mailFromDomain:
				typeof result.MailFromAttributes?.MailFromDomain === 'string'
					? result.MailFromAttributes.MailFromDomain
					: '',
			mailFromStatus:
				typeof result.MailFromAttributes?.MailFromDomainStatus === 'string'
					? result.MailFromAttributes.MailFromDomainStatus
					: 'UNKNOWN'
		};
	}

	/** SES sandbox mode requires every recipient identity to be individually verified. */
	async verifyRecipientIdentity(address: string): Promise<boolean> {
		if (!this.credentials || !this.region)
			throw new ProviderUnavailableError('AWS SES', 'AWS credentials and AWS_REGION are required');
		if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) return false;
		const identity = (await this.signedGet(
			`/v2/email/identities/${encodeURIComponent(address)}`
		)) as { VerifiedForSendingStatus?: unknown };
		return identity.VerifiedForSendingStatus === true;
	}

	async getSendingQuota(): Promise<{
		max24HourSend: number;
		sentLast24Hours: number;
		maxSendRate: number;
		productionAccessEnabled: boolean;
	}> {
		if (!this.credentials || !this.region)
			throw new ProviderUnavailableError('AWS SES', 'AWS credentials and AWS_REGION are required');
		const account = (await this.signedGet('/v2/email/account')) as {
			ProductionAccessEnabled?: unknown;
			SendQuota?: { Max24HourSend?: unknown; SentLast24Hours?: unknown; MaxSendRate?: unknown };
		};
		const quota = account.SendQuota ?? {};
		const finite = (value: unknown) =>
			typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
		return {
			max24HourSend: finite(quota.Max24HourSend),
			sentLast24Hours: finite(quota.SentLast24Hours),
			maxSendRate: finite(quota.MaxSendRate),
			productionAccessEnabled: account.ProductionAccessEnabled === true
		};
	}

	private async signedGet(path: string): Promise<unknown> {
		const host = `email.${this.region}.amazonaws.com`;
		const now = new Date();
		const amzDate = awsTimestamp(now);
		const date = amzDate.slice(0, 8);
		const payloadHash = sha256('');
		const headers: Record<string, string> = {
			host,
			'x-amz-content-sha256': payloadHash,
			'x-amz-date': amzDate,
			...(this.credentials?.sessionToken
				? { 'x-amz-security-token': this.credentials.sessionToken }
				: {})
		};
		const signedHeaders = Object.keys(headers).sort().join(';');
		const canonicalHeaders = Object.keys(headers)
			.sort()
			.map((key) => `${key}:${headers[key]?.trim()}\n`)
			.join('');
		const canonicalRequest = ['GET', path, '', canonicalHeaders, signedHeaders, payloadHash].join(
			'\n'
		);
		const scope = `${date}/${this.region}/ses/aws4_request`;
		const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${sha256(canonicalRequest)}`;
		const dateKey = hmac(`AWS4${this.credentials!.secretAccessKey}`, date);
		const regionKey = hmac(dateKey, this.region);
		const serviceKey = hmac(regionKey, 'ses');
		const signingKey = hmac(serviceKey, 'aws4_request');
		headers.authorization = `AWS4-HMAC-SHA256 Credential=${this.credentials!.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${createHmac('sha256', signingKey).update(stringToSign).digest('hex')}`;
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
		try {
			const response = await this.fetcher(`https://${host}${path}`, {
				method: 'GET',
				headers,
				signal: controller.signal
			});
			if (!response.ok)
				throw new Error(`SES configuration check failed with HTTP ${response.status}`);
			return await response.json();
		} catch (error) {
			throw new Error(
				`AWS SES configuration check failed: ${error instanceof Error && error.name === 'AbortError' ? 'timeout' : error instanceof Error ? error.message : 'provider error'}`
			);
		} finally {
			clearTimeout(timeout);
		}
	}
}
