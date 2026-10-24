import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { env } from '$env/dynamic/private';
import { PortalError, updatePortalPreferences } from '$lib/server/portal';
import { readLimitedBody } from '$lib/server/request';

const schema = z
	.object({ receiptEmails: z.boolean().optional(), newsletterOptIn: z.boolean().optional() })
	.strict()
	.refine((value) => value.receiptEmails !== undefined || value.newsletterOptIn !== undefined);
export async function PATCH({ request, cookies }) {
	let input: z.infer<typeof schema>;
	try {
		input = schema.parse(JSON.parse(await readLimitedBody(request, 4096)));
	} catch (error) {
		return json(
			{
				error: error instanceof RangeError ? 'Request is too large.' : 'Choose a valid preference.'
			},
			{ status: error instanceof RangeError ? 413 : 400 }
		);
	}
	if (!env.DATABASE_URL) return json({ error: 'Donor portal is unavailable.' }, { status: 503 });
	try {
		return json(
			{ preferences: await updatePortalPreferences(cookies.get('giveloom_portal'), input) },
			{ headers: { 'cache-control': 'private, no-store' } }
		);
	} catch (error) {
		return json(
			{ error: error instanceof PortalError ? error.message : 'Preferences could not be saved.' },
			{ status: error instanceof PortalError ? error.status : 503 }
		);
	}
}
