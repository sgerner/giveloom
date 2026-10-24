import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { env } from '$env/dynamic/private';
import { PortalError, updatePortalProfile } from '$lib/server/portal';
import { readLimitedBody } from '$lib/server/request';

const addressSchema = z
	.object({
		line1: z.string().trim().min(1).max(120),
		line2: z.string().trim().max(120).optional(),
		city: z.string().trim().min(1).max(100),
		region: z.string().trim().min(1).max(100),
		postalCode: z.string().trim().min(1).max(24),
		country: z.string().regex(/^[A-Za-z]{2}$/)
	})
	.strict();
const schema = z
	.object({ name: z.string().trim().min(2).max(120), address: addressSchema.nullable() })
	.strict();

export async function PATCH({ request, cookies }) {
	let input: z.infer<typeof schema>;
	try {
		input = schema.parse(JSON.parse(await readLimitedBody(request, 4096)));
	} catch (error) {
		return json(
			{
				error:
					error instanceof RangeError
						? 'Request is too large.'
						: 'Provide a valid name and mailing address.'
			},
			{ status: error instanceof RangeError ? 413 : 400 }
		);
	}
	if (!env.DATABASE_URL) return json({ error: 'Donor portal is unavailable.' }, { status: 503 });
	try {
		return json(
			{ profile: await updatePortalProfile(cookies.get('giveloom_portal'), input) },
			{ headers: { 'cache-control': 'private, no-store' } }
		);
	} catch (error) {
		return json(
			{ error: error instanceof PortalError ? error.message : 'Profile could not be saved.' },
			{
				status: error instanceof PortalError ? error.status : 503,
				headers: { 'cache-control': 'private, no-store' }
			}
		);
	}
}
