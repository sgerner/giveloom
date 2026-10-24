import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { env } from '$env/dynamic/private';
import { consumePortalLink, PortalError } from '$lib/server/portal';
import { readLimitedBody } from '$lib/server/request';

const schema = z.object({ token: z.string().min(20).max(2048) }).strict();
const cookieName = 'giveloom_portal';
export async function POST({ request, cookies }) {
	let input: z.infer<typeof schema>;
	try {
		input = schema.parse(JSON.parse(await readLimitedBody(request, 4096)));
	} catch (error) {
		return json(
			{
				error:
					error instanceof RangeError
						? 'Request is too large.'
						: 'This sign-in link is invalid or expired.'
			},
			{ status: error instanceof RangeError ? 413 : 400 }
		);
	}
	if (!env.DATABASE_URL)
		return json({ error: 'Donor portal sign-in is unavailable.' }, { status: 503 });
	try {
		const { cookie } = await consumePortalLink(input.token);
		cookies.set(cookieName, cookie, {
			path: '/',
			httpOnly: true,
			sameSite: 'lax',
			secure: process.env.NODE_ENV === 'production',
			maxAge: 30 * 24 * 60 * 60
		});
		return json({ ok: true }, { headers: { 'cache-control': 'no-store' } });
	} catch (error) {
		const status = error instanceof PortalError ? error.status : 503;
		return json(
			{
				error:
					error instanceof PortalError
						? error.message
						: 'Donor portal sign-in is temporarily unavailable.'
			},
			{ status, headers: { 'cache-control': 'no-store' } }
		);
	}
}
