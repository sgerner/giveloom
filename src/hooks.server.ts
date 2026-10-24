import type { Handle } from '@sveltejs/kit';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '$env/dynamic/private';
import { authRateLimit } from '$lib/server/auth-rate-limit';
import { validateSession } from '$lib/server/database';
import { demoModeAvailable } from '$lib/server/store';

const cookieName = 'giveloom_session';
function key() {
	return (
		env.SESSION_SECRET || (process.env.NODE_ENV === 'production' ? '' : 'local-demo-only-change-me')
	);
}
function decode(value: string) {
	const parts = value.split('.');
	if (parts.length !== 2) return null;
	const [payload, signature] = parts;
	if (!payload || !signature || !key()) return null;
	const expected = createHmac('sha256', key()).update(payload).digest('base64url');
	const a = Buffer.from(signature);
	const b = Buffer.from(expected);
	if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
	try {
		const data = JSON.parse(Buffer.from(payload, 'base64url').toString()) as {
			userId: string;
			tenantSlug: string;
			role: string;
			demo: boolean;
			sessionId?: string;
			sessionVersion?: number;
			exp: number;
		};
		if (data.exp < Date.now()) return null;
		if (
			!data.userId ||
			!data.tenantSlug ||
			!data.role ||
			(data.demo !== true && (!data.sessionId || !Number.isInteger(data.sessionVersion)))
		)
			return null;
		return {
			userId: data.userId,
			tenantSlug: data.tenantSlug,
			role: data.role,
			demo: data.demo,
			sessionId: data.sessionId,
			sessionVersion: data.sessionVersion,
			expiresAt: data.exp
		};
	} catch {
		return null;
	}
}
export const sessionTtlMs = 1000 * 60 * 60 * 12;
export function makeSession(
	data: {
		userId: string;
		tenantSlug: string;
		role: string;
		demo: boolean;
		sessionId?: string;
		sessionVersion?: number;
	},
	expiresInMs = sessionTtlMs
) {
	if (!key()) throw new Error('SESSION_SECRET must be configured');
	const payload = Buffer.from(JSON.stringify({ ...data, exp: Date.now() + expiresInMs })).toString(
		'base64url'
	);
	return `${payload}.${createHmac('sha256', key()).update(payload).digest('base64url')}`;
}
export const verifySessionToken = decode;

export const handle: Handle = async ({ event, resolve }) => {
	const origin = event.request.headers.get('origin');
	if (origin && !['GET', 'HEAD', 'OPTIONS'].includes(event.request.method)) {
		let validOrigin = false;
		try {
			const parsed = new URL(origin);
			validOrigin =
				parsed.host === event.url.host &&
				(process.env.NODE_ENV !== 'production' || parsed.protocol === 'https:');
		} catch {
			validOrigin = false;
		}
		if (!validOrigin)
			return new Response(JSON.stringify({ error: 'Cross-origin requests are not allowed.' }), {
				status: 403,
				headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
			});
	}
	const isolatedDemo = process.env.NODE_ENV === 'production' && demoModeAvailable();
	if (isolatedDemo) {
		const path = event.url.pathname;
		const providerOrIdentity = [
			'/api/v1/identity/',
			'/api/v1/payments/',
			'/api/v1/ai/',
			'/api/v1/webhooks/',
			'/api/v1/portal/auth/'
		].some((prefix) => path.startsWith(prefix));
		const realAction =
			[
				'/api/v1/signup',
				'/api/v1/email/send',
				'/api/v1/email/test-send',
				'/api/v1/email/consent/request'
			].includes(path) ||
			(path === '/api/v1/session' && event.request.method === 'POST') ||
			(path.startsWith('/api/v1/integrations/') && !['GET', 'HEAD'].includes(event.request.method));
		if (providerOrIdentity || realAction) {
			return new Response(
				JSON.stringify({
					error:
						'Real accounts, credentials and live provider actions are disabled in this shared demo.'
				}),
				{
					status: 403,
					headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
				}
			);
		}
		if (['/signup', '/login'].includes(path) && env.REAL_APP_URL) {
			const target = new URL(path, env.REAL_APP_URL);
			if (target.protocol === 'https:')
				return new Response(null, { status: 303, headers: { location: target.href } });
		}
	}
	event.locals.session = decode(event.cookies.get(cookieName) || '');
	if (event.locals.session?.demo && !demoModeAvailable()) event.locals.session = null;
	if (event.locals.session && !event.locals.session.demo) {
		try {
			if (!(await validateSession(event.locals.session))) event.locals.session = null;
		} catch {
			event.locals.session = null;
		}
	}
	if (event.url.pathname.startsWith('/app/') && !event.locals.session) {
		return new Response(null, { status: 303, headers: { location: '/' } });
	}
	if (
		event.locals.session &&
		!event.locals.session.demo &&
		event.url.pathname.startsWith('/api/v1/') &&
		!event.url.pathname.startsWith('/api/v1/webhooks/')
	) {
		const session = event.locals.session;
		const rate = await authRateLimit('api', 'tenant:' + session.tenantSlug, 1800, 60);
		if (!rate.available)
			return new Response(JSON.stringify({ error: 'API protection is temporarily unavailable.' }), {
				status: 503,
				headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store' }
			});
		if (!rate.allowed)
			return new Response(
				JSON.stringify({ error: 'Workspace request limit reached. Try again in a minute.' }),
				{
					status: 429,
					headers: {
						'content-type': 'application/json',
						'retry-after': '60',
						'cache-control': 'private, no-store'
					}
				}
			);
	}
	const response = await resolve(event);
	if (event.locals.session) response.headers.set('cache-control', 'private, no-store');
	if (!response.headers.has('content-security-policy'))
		response.headers.set(
			'content-security-policy',
			"frame-ancestors 'none'; object-src 'none'; base-uri 'self'"
		);
	response.headers.set('x-content-type-options', 'nosniff');
	response.headers.set('referrer-policy', 'strict-origin-when-cross-origin');
	response.headers.set('permissions-policy', 'camera=(), microphone=(), geolocation=()');
	return response;
};
export { cookieName };
