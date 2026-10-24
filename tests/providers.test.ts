import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
	DisabledAIProvider,
	DisabledOutboundEmailProvider,
	DisabledPaymentProvider,
	DisabledResearchProvider
} from '../src/lib/providers/disabled';
import { FilesystemBlobStorage } from '../src/lib/providers/filesystem';
import { StripePaymentProvider } from '../src/lib/providers/stripe';
import { OpenAIResponsesProvider } from '../src/lib/providers/ai';
import { SesEmailProvider } from '../src/lib/providers/ses';
import { CredentialVault } from '../src/lib/providers/vault.server';
import {
	FakeAIProvider,
	FakeBlobStorage,
	FakeOutboundEmailProvider,
	FakePaymentProvider,
	FakeResearchProvider
} from '../src/lib/providers/test-adapters';

const tenantA = '6c59b62f-12c7-4ab0-8a58-52cfc1133021';
const tenantB = 'e43815bb-349d-4fab-a33b-3495c06a137b';
const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0]);
let temporaryDirectory: string | undefined;

afterEach(async () => {
	if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
	temporaryDirectory = undefined;
});

describe('production-disabled provider defaults', () => {
	it('fail explicitly instead of faking successful external work', async () => {
		expect(new DisabledPaymentProvider().descriptor.mode).toBe('disabled');
		expect(new DisabledOutboundEmailProvider().descriptor.mode).toBe('disabled');
		expect(new DisabledResearchProvider().descriptor.mode).toBe('disabled');
		expect(new DisabledAIProvider().descriptor.mode).toBe('disabled');
		await expect(
			new DisabledPaymentProvider().createIntent({
				tenantId: tenantA,
				connectedAccountId: 'acct_test',
				amount: { amountMinor: 100, currency: 'USD' },
				idempotencyKey: 'gift-1'
			})
		).rejects.toThrow(/unavailable/);
		await expect(
			new DisabledOutboundEmailProvider().send({
				tenantId: tenantA,
				to: 'a@example.org',
				from: 'b@example.org',
				subject: 'Hi',
				text: 'Hello',
				idempotencyKey: 'mail-1'
			})
		).rejects.toThrow(/unavailable/);
		await expect(
			new DisabledResearchProvider().search({ missionKeywords: ['food'], limit: 5 })
		).rejects.toThrow(/unavailable/);
		await expect(
			new DisabledAIProvider().complete({
				tenantId: tenantA,
				apiKey: 'secret',
				model: 'model',
				system: '',
				user: ''
			})
		).rejects.toThrow(/Codex device-code mode is disabled/);
	});
});

describe('Stripe Connect payment adapter', () => {
	it('stays disabled without a server key and validates account/amount before network calls', async () => {
		const disabled = new StripePaymentProvider('');
		expect(disabled.descriptor.mode).toBe('disabled');
		await expect(
			disabled.createIntent({
				tenantId: tenantA,
				connectedAccountId: 'acct_test',
				amount: { amountMinor: 100, currency: 'USD' },
				idempotencyKey: 'gift-1'
			})
		).rejects.toThrow(/not configured/);

		const testMode = new StripePaymentProvider('sk_test_not-a-real-secret');
		expect(testMode.descriptor.mode).toBe('test');
		await expect(
			testMode.createIntent({
				tenantId: tenantA,
				connectedAccountId: 'not-an-account',
				amount: { amountMinor: 100, currency: 'USD' },
				idempotencyKey: 'gift-1'
			})
		).rejects.toThrow(/Connect account ID/);
		await expect(
			testMode.createIntent({
				tenantId: tenantA,
				connectedAccountId: 'acct_example1',
				amount: { amountMinor: 0, currency: 'USD' },
				idempotencyKey: 'gift-1'
			})
		).rejects.toThrow(/positive integer/);
	});
});

describe('server provider adapters', () => {
	const tenantKey = { tenantId: tenantA, provider: 'openai', credentialId: 'primary' };
	const keyA = Buffer.alloc(32, 11).toString('base64');
	const keyB = Buffer.alloc(32, 12).toString('base64');

	it('bounds AI input/output budget, keeps tenant key request-scoped, and handles provider errors safely', async () => {
		let request: Request | undefined;
		const provider = new OpenAIResponsesProvider({
			maxInputCharacters: 100,
			maxOutputTokens: 50,
			fetcher: async (input, init) => {
				request = new Request(input, init);
				return Response.json({
					output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }],
					model: 'gpt-test',
					usage: { input_tokens: 4, output_tokens: 1 }
				});
			}
		});
		const result = await provider.complete({
			tenantId: tenantA,
			apiKey: 'tenant-secret',
			model: 'gpt-test',
			system: 'rules',
			user: 'prompt'
		});
		expect(result).toMatchObject({ text: 'ok', model: 'gpt-test', inputTokens: 4 });
		expect(request?.headers.get('authorization')).toBe('Bearer tenant-secret');
		await expect(
			provider.complete({
				tenantId: tenantA,
				apiKey: 'tenant-secret',
				model: 'gpt-test',
				system: '',
				user: 'x'.repeat(101)
			})
		).rejects.toThrow(/budget/);
		const failed = new OpenAIResponsesProvider({
			fetcher: async () => new Response('secret details', { status: 401 })
		});
		await expect(
			failed.complete({
				tenantId: tenantA,
				apiKey: 'tenant-secret',
				model: 'gpt-test',
				system: '',
				user: 'hello'
			})
		).rejects.toThrow(/HTTP 401/);
	});

	it('signs SES requests and refuses an unverified sender before network calls', async () => {
		let request: Request | undefined;
		const provider = new SesEmailProvider({
			region: 'us-east-1',
			fromAddress: 'verified@example.org',
			credentials: { accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'example-secret' },
			fetcher: async (input, init) => {
				request = new Request(input, init);
				return Response.json({ MessageId: 'ses-message-1' });
			}
		});
		await expect(
			provider.send({
				tenantId: tenantA,
				to: 'donor@example.org',
				from: 'spoof@example.org',
				subject: 'Thanks',
				text: 'Thank you',
				idempotencyKey: 'gift-1'
			})
		).rejects.toThrow(/verified SES sender/);
		const result = await provider.send({
			tenantId: tenantA,
			to: 'donor@example.org',
			from: 'verified@example.org',
			subject: 'Thanks',
			text: 'Thank you',
			idempotencyKey: 'gift-1'
		});
		expect(result.providerMessageId).toBe('ses-message-1');
		expect(request?.headers.get('authorization')).toMatch(
			/^AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE\//
		);
	});

	it('reads domain verification and DKIM configuration without returning credentials', async () => {
		let request: Request | undefined;
		const provider = new SesEmailProvider({
			region: 'us-east-1',
			fromAddress: 'appeals@example.org',
			credentials: { accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'example-secret' },
			fetcher: async (input, init) => {
				request = new Request(input, init);
				return Response.json({
					VerificationStatus: 'SUCCESS',
					VerifiedForSendingStatus: true,
					DkimAttributes: {
						Status: 'SUCCESS',
						SigningEnabled: true,
						Tokens: ['token123', 'unsafe.token']
					},
					MailFromAttributes: {
						MailFromDomain: 'bounce.example.org',
						MailFromDomainStatus: 'SUCCESS'
					}
				});
			}
		});
		const result = await provider.inspectIdentity('example.org');
		expect(result).toMatchObject({
			verifiedForSending: true,
			verificationStatus: 'SUCCESS',
			dkimStatus: 'SUCCESS',
			dkimEnabled: true,
			dkimTokens: ['token123'],
			mailFromDomain: 'bounce.example.org',
			mailFromStatus: 'SUCCESS'
		});
		expect(request?.url).toBe(
			'https://email.us-east-1.amazonaws.com/v2/email/identities/example.org'
		);
		expect(request?.headers.get('authorization')).toMatch(
			/^AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE\//
		);
		await expect(provider.inspectIdentity('bad domain')).rejects.toThrow(/identity domain/);
	});

	it('encrypts tenant-bound credentials with envelope keys and rotates active key versions', () => {
		const oldVault = new CredentialVault({ keyring: { old: keyA }, activeKeyId: 'old' });
		const rotatedVault = new CredentialVault({
			keyring: { old: keyA, current: keyB },
			activeKeyId: 'current'
		});
		const envelope = oldVault.encrypt(tenantKey, 'provider-secret');
		expect(envelope).not.toContain('provider-secret');
		expect(oldVault.decrypt(tenantKey, envelope)).toBe('provider-secret');
		expect(() => oldVault.decrypt({ ...tenantKey, tenantId: tenantB }, envelope)).toThrow(
			/bound to another tenant/
		);
		const rotated = rotatedVault.rotate(tenantKey, envelope);
		expect(rotatedVault.decrypt(tenantKey, rotated)).toBe('provider-secret');
		expect(() =>
			new CredentialVault({ keyring: { current: keyB }, activeKeyId: 'current' }).decrypt(
				tenantKey,
				envelope
			)
		).toThrow(/invalid/);
	});
});

describe('filesystem blob storage', () => {
	it('stores private opaque objects within tenant folders and checks uploaded type bytes', async () => {
		temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'giveloom-files-'));
		const storage = new FilesystemBlobStorage({
			root: temporaryDirectory,
			signingSecret: 'test-signing-secret'
		});
		const { objectId } = await storage.put({
			tenantId: tenantA,
			bytes: png,
			mediaType: 'image/png',
			originalName: '../../private.png'
		});
		const fetched = await storage.get({ tenantId: tenantA, objectId });
		expect(fetched.mediaType).toBe('image/png');
		expect([...fetched.bytes]).toEqual([...png]);
		await expect(storage.get({ tenantId: tenantB, objectId })).rejects.toThrow();
		await expect(
			storage.put({
				tenantId: tenantA,
				bytes: png,
				mediaType: 'application/pdf',
				originalName: 'file.pdf'
			})
		).rejects.toThrow(/does not match/);
	});

	it('signs only short-lived authenticated download paths and rejects expired or altered signatures', async () => {
		const storage = new FilesystemBlobStorage({
			root: '/tmp/giveloom-unused',
			signingSecret: 'test-signing-secret'
		});
		const link = await storage.signedDownload({
			tenantId: tenantA,
			objectId: tenantB,
			expiresInSeconds: 60
		});
		const match = link.match(/expires=(\d+)&signature=([0-9a-f]+)/);
		expect(match).not.toBeNull();
		const expires = Number(match?.[1]);
		const signature = match?.[2] ?? '';
		expect(
			FilesystemBlobStorage.verifyDownload({
				tenantId: tenantA,
				objectId: tenantB,
				expires,
				signature,
				secret: 'test-signing-secret'
			})
		).toBe(true);
		expect(
			FilesystemBlobStorage.verifyDownload({
				tenantId: tenantA,
				objectId: tenantB,
				expires,
				signature: `${signature}00`,
				secret: 'test-signing-secret'
			})
		).toBe(false);
		expect(
			FilesystemBlobStorage.verifyDownload({
				tenantId: tenantA,
				objectId: tenantB,
				expires,
				signature,
				secret: 'test-signing-secret',
				nowSeconds: expires
			})
		).toBe(false);
	});
});

describe('explicit test adapters', () => {
	it('are labeled test-only and provide deterministic synthetic fixtures', async () => {
		const payment = new FakePaymentProvider();
		const email = new FakeOutboundEmailProvider();
		const research = new FakeResearchProvider();
		const ai = new FakeAIProvider();
		const blob = new FakeBlobStorage();
		expect(
			[
				payment.descriptor,
				email.descriptor,
				research.descriptor,
				ai.descriptor,
				blob.descriptor
			].every((item) => item.mode === 'test')
		).toBe(true);
		expect(
			(
				await payment.createIntent({
					tenantId: tenantA,
					connectedAccountId: 'acct_test',
					amount: { amountMinor: 100, currency: 'USD' },
					idempotencyKey: 'gift-1'
				})
			).providerIntentId
		).toBe('test_gift-1');
		await email.send({
			tenantId: tenantA,
			to: 'a@example.org',
			from: 'b@example.org',
			subject: 'Hi',
			text: 'Hello',
			idempotencyKey: 'mail-1'
		});
		expect(email.sent).toHaveLength(1);
		expect((await research.search({ missionKeywords: ['food'], limit: 1 }))[0]?.license).toBe(
			'synthetic-only'
		);
		expect(
			(
				await ai.complete({
					tenantId: tenantA,
					apiKey: 'test-only',
					model: 'fixture',
					system: '',
					user: ''
				})
			).text
		).toContain(tenantA);
		const stored = await blob.put({
			tenantId: tenantA,
			bytes: png,
			mediaType: 'image/png',
			originalName: 'fixture.png'
		});
		await expect(blob.get({ tenantId: tenantB, objectId: stored.objectId })).rejects.toThrow(
			/not found/
		);
	});
});
