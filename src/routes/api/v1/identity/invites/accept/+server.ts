import { json } from '@sveltejs/kit';
import argon2 from 'argon2';
import { z } from 'zod';
import { cookieName, makeSession, sessionTtlMs } from '../../../../../../hooks.server';
import { registerSession, workspaceFromPostgres } from '$lib/server/database';
import { acceptTenantInvite } from '$lib/server/identity';
const schema = z
	.object({
		token: z.string().min(20).max(256),
		name: z.string().trim().min(1).max(120).optional(),
		password: z.string().min(12).max(128).optional()
	})
	.strict();
export async function POST({ request, locals, cookies }) {
	try {
		const body = schema.parse(await request.json());
		let existingUser: undefined | { id: string; email: string };
		if (locals.session && !locals.session.demo) {
			const workspace = await workspaceFromPostgres(
				locals.session.tenantSlug,
				locals.session.userId,
				locals.session.role
			);
			if (workspace) existingUser = { id: workspace.user.id, email: workspace.user.email };
		}
		let passwordHash = '';
		if (!existingUser) {
			if (!body.name || !body.password)
				return json(
					{ error: 'Enter your name and a password of at least 12 characters.' },
					{ status: 400 }
				);
			passwordHash = await argon2.hash(body.password, {
				type: argon2.argon2id,
				memoryCost: 19456,
				timeCost: 2,
				parallelism: 1
			});
		}
		const accepted = await acceptTenantInvite(body.token, {
			name: body.name,
			passwordHash,
			existingUser
		});
		if (!accepted)
			return json(
				{ error: 'This invitation is invalid, expired, or already used.' },
				{ status: 400 }
			);
		if (accepted.existing)
			return json(
				{
					error:
						'This email already has an account. Sign in to that account, then open the invitation again.'
				},
				{ status: 409 }
			);
		if (accepted.emailMismatch)
			return json(
				{ error: 'Sign in with the invited email address to accept this invitation.' },
				{ status: 403 }
			);
		const expires = new Date(Date.now() + sessionTtlMs);
		const sessionId = await registerSession(
			accepted.userId,
			accepted.tenantSlug,
			accepted.sessionVersion,
			expires
		);
		cookies.set(
			cookieName,
			makeSession({
				userId: accepted.userId,
				tenantSlug: accepted.tenantSlug,
				role: accepted.role,
				demo: false,
				sessionId,
				sessionVersion: accepted.sessionVersion
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
			{ ok: true, tenant: accepted.tenantSlug },
			{ headers: { 'cache-control': 'no-store' } }
		);
	} catch (error) {
		if (error instanceof z.ZodError)
			return json({ error: 'Invitation link or account details are invalid.' }, { status: 400 });
		console.error(
			'Invitation acceptance unavailable',
			error instanceof Error ? error.message : 'unknown'
		);
		return json({ error: 'Invitation could not be accepted.' }, { status: 503 });
	}
}
