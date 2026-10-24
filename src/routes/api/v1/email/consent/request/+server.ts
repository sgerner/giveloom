import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { CommunicationError, requestEmailConsent } from '$lib/server/communications';
const schema = z
	.object({ tenant: z.string().min(1).max(80), email: z.string().trim().email().max(254) })
	.strict();
export async function POST({ request, getClientAddress }) {
	try {
		const body = schema.parse(await request.json());
		await requestEmailConsent(body.tenant, body.email, undefined, getClientAddress());
		return json({ accepted: true }, { status: 202, headers: { 'cache-control': 'no-store' } });
	} catch (error) {
		const invalid = error instanceof z.ZodError;
		return json(
			{
				error:
					error instanceof CommunicationError
						? error.message
						: invalid
							? 'A valid workspace and email are required.'
							: 'Consent request service is temporarily unavailable.'
			},
			{
				status: error instanceof CommunicationError ? error.status : invalid ? 400 : 503,
				headers: { 'cache-control': 'no-store' }
			}
		);
	}
}
