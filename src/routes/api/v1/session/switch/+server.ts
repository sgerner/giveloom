import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { listMemberships, registerSession, revokeSession } from '$lib/server/database';
import { cookieName, makeSession, sessionTtlMs } from '../../../../../hooks.server';

export async function POST({ request, locals, cookies }) {
	const current = locals.session;
	if (!current) return json({ error: 'Sign in before switching workspaces.' }, { status: 401 });
	let tenant: string;
	try {
		tenant = z
			.object({ tenant: z.string().min(1).max(80) })
			.strict()
			.parse(await request.json()).tenant;
	} catch {
		return json({ error: 'Provide a valid tenant slug.' }, { status: 400 });
	}
	if (current.demo) {
		if (!['riverstone', 'harbor'].includes(tenant))
			return json({ error: 'Workspace is not available in this demo.' }, { status: 403 });
		cookies.set(
			cookieName,
			makeSession({ userId: `demo:${tenant}`, tenantSlug: tenant, role: 'owner', demo: true }),
			{
				path: '/',
				httpOnly: true,
				sameSite: 'lax',
				secure: process.env.NODE_ENV === 'production',
				maxAge: Math.floor(sessionTtlMs / 1000)
			}
		);
		return json({ ok: true, tenant, demo: true });
	}
	try {
		const memberships = await listMemberships(current.userId);
		const membership = memberships.find((item) => item.slug === tenant);
		if (!membership)
			return json({ error: 'You do not have access to that workspace.' }, { status: 403 });
		const expiresAt = new Date(Date.now() + sessionTtlMs);
		const nextId = await registerSession(
			current.userId,
			tenant,
			current.sessionVersion!,
			expiresAt
		);
		await revokeSession(current);
		cookies.set(
			cookieName,
			makeSession({
				userId: current.userId,
				tenantSlug: tenant,
				role: membership.role,
				demo: false,
				sessionId: nextId,
				sessionVersion: current.sessionVersion
			}),
			{
				path: '/',
				httpOnly: true,
				sameSite: 'lax',
				secure: process.env.NODE_ENV === 'production',
				maxAge: Math.floor(sessionTtlMs / 1000)
			}
		);
		return json(
			{ ok: true, tenant, memberships },
			{ headers: { 'cache-control': 'private, no-store' } }
		);
	} catch {
		return json({ error: 'Workspace switch is temporarily unavailable.' }, { status: 503 });
	}
}
