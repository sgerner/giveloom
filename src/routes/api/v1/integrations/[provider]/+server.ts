import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { IntegrationError, removeIntegration, saveIntegration } from '$lib/server/integrations';
import { SesEmailProvider } from '$lib/providers/ses';

const openAiSchema = z
	.object({
		apiKey: z.string().min(20).max(512).regex(/^\S+$/),
		model: z
			.string()
			.min(1)
			.max(100)
			.regex(/^[A-Za-z0-9._:-]+$/),
		enabled: z.boolean().default(true)
	})
	.strict();
const sesSchema = z
	.object({
		region: z.string().regex(/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/),
		fromAddress: z.string().email().max(254),
		accessKeyId: z.string().min(16).max(128).regex(/^\S+$/),
		secretAccessKey: z.string().min(20).max(512).regex(/^\S+$/),
		sessionToken: z.string().min(1).max(4096).regex(/^\S+$/).optional(),
		enabled: z.boolean().default(false)
	})
	.strict();

function requireHttps(request: Request) {
	if (process.env.NODE_ENV !== 'production') return;
	const forwarded = request.headers.get('x-forwarded-proto');
	if (new URL(request.url).protocol !== 'https:' && forwarded !== 'https')
		throw new IntegrationError('Provider credentials may only be submitted over HTTPS.', 400);
}

export async function PUT({ request, locals, params }) {
	const session = locals.session;
	if (!session) return json({ error: 'Sign in before managing integrations.' }, { status: 401 });
	if (!['openai', 'ses'].includes(params.provider))
		return json({ error: 'Unsupported provider.' }, { status: 404 });
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return json({ error: 'A JSON provider configuration is required.' }, { status: 400 });
	}
	if (!body || typeof body !== 'object' || Array.isArray(body))
		return json({ error: 'A JSON provider configuration is required.' }, { status: 400 });
	const provider = params.provider as 'openai' | 'ses';
	if (session.demo) {
		const keys = Object.keys(body);
		if (keys.some((key) => key !== 'enabled') || (body as { enabled?: unknown }).enabled === true)
			return json(
				{ error: 'Demo mode cannot store credentials or enable providers.' },
				{ status: 403 }
			);
		return json(
			{
				ok: true,
				provider,
				configured: false,
				enabled: false,
				status: 'disabled_demo',
				metadata: {}
			},
			{ status: 200, headers: { 'cache-control': 'private, no-store' } }
		);
	}
	try {
		requireHttps(request);
		let result;
		if (provider === 'openai') {
			const parsed = openAiSchema.parse(body);
			result = await saveIntegration(session, provider, parsed, parsed.enabled);
		} else {
			const parsed = sesSchema.parse(body);
			if (parsed.enabled) {
				const ses = new SesEmailProvider({
					region: parsed.region,
					fromAddress: parsed.fromAddress,
					credentials: {
						accessKeyId: parsed.accessKeyId,
						secretAccessKey: parsed.secretAccessKey,
						...(parsed.sessionToken ? { sessionToken: parsed.sessionToken } : {})
					}
				});
				const verified = await ses.verifySenderIdentity(parsed.fromAddress);
				if (!verified.verifiedForSending)
					throw new IntegrationError(
						'SES does not report this sender identity as verified for sending.',
						422
					);
				const quota = await ses.getSendingQuota();
				if (quota.maxSendRate <= 0 || quota.max24HourSend <= 0)
					throw new IntegrationError(
						'SES does not report an active sending quota for this account.',
						422
					);
			}
			result = await saveIntegration(session, provider, parsed, parsed.enabled);
		}
		return json(
			{ ok: true, ...result },
			{ status: 200, headers: { 'cache-control': 'private, no-store' } }
		);
	} catch (error) {
		if (error instanceof z.ZodError)
			return json(
				{
					error: 'Provider configuration is invalid.',
					details: error.issues.map(({ path, code }) => ({ path, code }))
				},
				{ status: 422 }
			);
		const status = error instanceof IntegrationError ? error.status : 503;
		return json(
			{
				error:
					error instanceof IntegrationError
						? error.message
						: 'Provider configuration could not be saved.'
			},
			{ status, headers: { 'cache-control': 'no-store' } }
		);
	}
}

export async function DELETE({ locals, params }) {
	const session = locals.session;
	if (!session) return json({ error: 'Sign in before managing integrations.' }, { status: 401 });
	if (!['openai', 'ses'].includes(params.provider))
		return json({ error: 'Unsupported provider.' }, { status: 404 });
	if (session.demo)
		return json(
			{
				ok: true,
				provider: params.provider,
				configured: false,
				enabled: false,
				status: 'disabled_demo',
				metadata: {}
			},
			{ headers: { 'cache-control': 'private, no-store' } }
		);
	try {
		return json(
			{ ok: true, ...(await removeIntegration(session, params.provider as 'openai' | 'ses')) },
			{ headers: { 'cache-control': 'private, no-store' } }
		);
	} catch (error) {
		const status = error instanceof IntegrationError ? error.status : 503;
		return json(
			{
				error:
					error instanceof IntegrationError
						? error.message
						: 'Provider configuration could not be removed.'
			},
			{ status, headers: { 'cache-control': 'no-store' } }
		);
	}
}
