import { env } from '$env/dynamic/private';
import { json } from '@sveltejs/kit';
import { applySesEvent, verifyWebhookMessage } from '$lib/server/communications';

const maxBodyBytes = 256 * 1024;
async function readBody(request: Request) {
	const length = Number(request.headers.get('content-length') ?? 0);
	if (length > maxBodyBytes) throw new RangeError('Webhook body too large');
	const reader = request.body?.getReader();
	if (!reader) return '';
	const chunks: Uint8Array[] = [];
	let size = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > maxBodyBytes) {
			await reader.cancel();
			throw new RangeError('Webhook body too large');
		}
		chunks.push(value);
	}
	return Buffer.concat(
		chunks.map((chunk) => Buffer.from(chunk)),
		size
	).toString('utf8');
}

export async function POST({ request }) {
	if (!env.SES_SNS_TOPIC_ARN)
		return json({ error: 'SES event ingestion is not configured.' }, { status: 503 });
	let envelope: Record<string, unknown>;
	try {
		envelope = JSON.parse(await readBody(request)) as Record<string, unknown>;
	} catch (error) {
		return json(
			{
				error:
					error instanceof RangeError
						? 'Webhook request is too large.'
						: 'A valid SNS JSON notification is required.'
			},
			{ status: error instanceof RangeError ? 413 : 400 }
		);
	}
	if (
		envelope.Type !== 'Notification' ||
		envelope.TopicArn !== env.SES_SNS_TOPIC_ARN ||
		typeof envelope.SigningCertURL !== 'string'
	)
		return json({ error: 'Unsupported or untrusted SNS message.' }, { status: 403 });
	const url = new URL(envelope.SigningCertURL);
	if (
		!/^sns\.[a-z0-9-]+\.amazonaws\.com(?:\.cn)?$/.test(url.hostname) ||
		url.protocol !== 'https:' ||
		!/^\/SimpleNotificationService-[A-Za-z0-9_-]+\.pem$/.test(url.pathname) ||
		url.search ||
		url.hash
	)
		return json({ error: 'SNS signing certificate URL is invalid.' }, { status: 403 });
	try {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 5000);
		let response: Response;
		try {
			response = await fetch(url, { signal: controller.signal, redirect: 'error' });
		} finally {
			clearTimeout(timer);
		}
		if (!response.ok)
			return json({ error: 'SNS signing certificate could not be verified.' }, { status: 503 });
		const cert = await response.text();
		if (cert.length > 32_000 || !cert.includes('BEGIN CERTIFICATE'))
			return json({ error: 'SNS signing certificate is invalid.' }, { status: 403 });
		if (!verifyWebhookMessage(envelope, cert))
			return json({ error: 'SNS signature verification failed.' }, { status: 403 });
		const event =
			typeof envelope.Message === 'string'
				? (JSON.parse(envelope.Message) as Record<string, any>)
				: null;
		if (!event) return json({ error: 'Unsupported SES event.' }, { status: 400 });
		const eventType = event.eventType ?? event.notificationType;
		if (!['Delivery', 'Bounce', 'Complaint', 'Open', 'Click'].includes(eventType))
			return json({ accepted: true, ignored: true });
		const providerMessageId = event.mail?.messageId;
		if (
			typeof providerMessageId !== 'string' ||
			providerMessageId.length > 256 ||
			typeof envelope.MessageId !== 'string'
		)
			return json({ error: 'SES event identifiers are invalid.' }, { status: 400 });
		const result = await applySesEvent({
			messageId: envelope.MessageId,
			providerMessageId,
			eventType,
			eventPayload: { eventType, timestamp: event.mail?.timestamp, source: event.mail?.source }
		});
		return json(result, { headers: { 'cache-control': 'no-store' } });
	} catch {
		return json({ error: 'SES event could not be verified or processed.' }, { status: 503 });
	}
}
