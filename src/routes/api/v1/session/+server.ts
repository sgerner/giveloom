import { json } from '@sveltejs/kit';
import argon2 from 'argon2';
import { z } from 'zod';
import { authRateLimit } from '$lib/server/auth-rate-limit';
import {
	authenticate,
	listMemberships,
	registerSession,
	revokeSession,
	workspaceFromPostgres
} from '$lib/server/database';
import { makeSession, cookieName, sessionTtlMs } from '../../../../hooks.server';
import { completeMfaLogin, createMfaLoginChallenge } from '$lib/server/identity';

const loginSchema = z
	.object({
		email: z.string().email().max(254),
		password: z.string().min(1).max(1024),
		tenant: z.string().min(1).max(80),
		mfaChallenge: z.string().min(20).max(256).optional(),
		mfaCode: z.string().min(6).max(32).optional()
	})
	.strict();
function setCookie(cookies: import('@sveltejs/kit').Cookies, token: string) {
	cookies.set(cookieName, token, {
		path: '/',
		httpOnly: true,
		sameSite: 'lax',
		secure: process.env.NODE_ENV === 'production',
		maxAge: Math.floor(sessionTtlMs / 1000)
	});
}
export async function GET({ locals }) {
	const session = locals.session;
	if (!session) return json({ error: 'Sign in first.' }, { status: 401 });
	if (session.demo) return json({ ok: true, demo: true, tenant: session.tenantSlug });
	try {
		const workspace = await workspaceFromPostgres(session.tenantSlug, session.userId, session.role);
		if (!workspace)
			return json({ error: 'The active membership is unavailable.' }, { status: 403 });
		return json(
			{
				ok: true,
				user: workspace.user,
				tenant: workspace.tenant,
				memberships: workspace.memberships
			},
			{ headers: { 'cache-control': 'private, no-store' } }
		);
	} catch {
		return json({ error: 'Session lookup is temporarily unavailable.' }, { status: 503 });
	}
}
export async function POST({ request, cookies, getClientAddress }) {
	let body: z.infer<typeof loginSchema>;
	try {
		body = loginSchema.parse(await request.json());
	} catch {
		return json({ error: 'Enter a valid email, password, and tenant.' }, { status: 400 });
	}
	const rate = await authRateLimit('login', getClientAddress(), 8, 60);
	if (!rate.available)
		return json({ error: 'Sign-in protection is temporarily unavailable.' }, { status: 503 });
	if (!rate.allowed)
		return json({ error: 'Too many login attempts. Try again in a minute.' }, { status: 429 });
	if (!process.env.DATABASE_URL)
		return json(
			{
				error:
					'Password login requires a configured database. Use the explicit demo login in development.'
			},
			{ status: 503 }
		);
	try {
		const user = await authenticate(body.email.trim().toLowerCase(), body.tenant);
		if (!user || !(await argon2.verify(user.password_hash, body.password)))
			return json({ error: 'Email, password, or tenant is incorrect.' }, { status: 401 });
		if (!user.email_verified_at)
			return json(
				{ error: 'Confirm your email before signing in.', emailVerificationRequired: true },
				{ status: 403 }
			);
		if (body.mfaChallenge || body.mfaCode) {
			if (!body.mfaChallenge || !body.mfaCode)
				return json({ error: 'Enter your authenticator or recovery code.' }, { status: 400 });
			const completed = await completeMfaLogin(body.tenant, body.mfaChallenge, body.mfaCode);
			if (!completed || completed.userId !== user.id)
				return json(
					{ error: 'The authenticator or recovery code is invalid or expired.' },
					{ status: 401 }
				);
		} else {
			const challenge = await createMfaLoginChallenge(body.tenant, user.id);
			if (challenge)
				return json(
					{ ok: true, mfaRequired: true, challengeToken: challenge },
					{ headers: { 'cache-control': 'no-store' } }
				);
		}
		const exp = new Date(Date.now() + sessionTtlMs);
		const sessionId = await registerSession(user.id, user.slug, user.session_version, exp);
		setCookie(
			cookies,
			makeSession({
				userId: user.id,
				tenantSlug: user.slug,
				role: user.role,
				demo: false,
				sessionId,
				sessionVersion: user.session_version
			})
		);
		return json(
			{
				ok: true,
				tenant: user.slug,
				user: { id: user.id, email: user.email, name: user.display_name, role: user.role },
				memberships: await listMemberships(user.id)
			},
			{ headers: { 'cache-control': 'private, no-store' } }
		);
	} catch (error) {
		console.error('Login unavailable', error instanceof Error ? error.message : 'unknown error');
		return json({ error: 'Login is temporarily unavailable.' }, { status: 503 });
	}
}
export async function DELETE({ cookies, locals }) {
	const session = locals.session;
	cookies.delete(cookieName, { path: '/' });
	if (session && !session.demo) {
		try {
			await revokeSession(session);
		} catch {
			return json(
				{ error: 'The browser session was cleared, but server revocation could not be confirmed.' },
				{ status: 503 }
			);
		}
	}
	return json({ ok: true });
}
