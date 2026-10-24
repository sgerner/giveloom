import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { getPortalOverview, PortalError, revokePortalSession } from '$lib/server/portal';

const cookieName = 'giveloom_portal';
export async function GET({ cookies }) {
	if (!env.DATABASE_URL) return json({ error: 'Donor portal is unavailable.' }, { status: 503 });
	try {
		const workspace = await getPortalOverview(cookies.get(cookieName));
		return workspace
			? json(workspace, { headers: { 'cache-control': 'private, no-store' } })
			: json(
					{ error: 'Sign in to view your donor portal.' },
					{ status: 401, headers: { 'cache-control': 'no-store' } }
				);
	} catch {
		return json({ error: 'Donor portal is temporarily unavailable.' }, { status: 503 });
	}
}

export async function DELETE({ cookies }) {
	const current = cookies.get(cookieName);
	cookies.delete(cookieName, { path: '/' });
	if (!env.DATABASE_URL) return json({ ok: true });
	try {
		await revokePortalSession(current);
		return json({ ok: true }, { headers: { 'cache-control': 'no-store' } });
	} catch (error) {
		return json(
			{
				error:
					error instanceof PortalError
						? error.message
						: 'The browser session was cleared, but server revocation could not be confirmed.'
			},
			{ status: 503 }
		);
	}
}
