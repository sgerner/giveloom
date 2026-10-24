import { afterEach, describe, expect, it, vi } from 'vitest';

const privateEnv = vi.hoisted(() => ({
	ENABLE_DEMO: '',
	DATABASE_URL: '',
	SESSION_SECRET: 'test-secret',
	PUBLIC_DEMO_URL: '',
	REAL_APP_URL: ''
}));
vi.mock('$env/dynamic/private', () => ({ env: privateEnv }));

import { load as homepage } from '../src/routes/+page.server';
import { demoModeAvailable } from '../src/lib/server/store';
import * as store from '../src/lib/server/store';
import { demoAuthorization } from '../src/lib/server/tenant-service';
import { GET } from '../src/routes/demo/start/+server';
import { cookieName, verifySessionToken, handle, makeSession } from '../src/hooks.server';

const oldNodeEnv = process.env.NODE_ENV;
afterEach(() => {
	process.env.NODE_ENV = oldNodeEnv;
	privateEnv.ENABLE_DEMO = '';
	privateEnv.DATABASE_URL = '';
	privateEnv.PUBLIC_DEMO_URL = '';
	privateEnv.REAL_APP_URL = '';
});

describe('production demo isolation', () => {
	it('keeps the existing non-production demo behavior', () => {
		process.env.NODE_ENV = 'test';
		privateEnv.DATABASE_URL = 'postgres://main-app';
		expect(demoModeAvailable()).toBe(true);
	});

	it('requires an explicit flag and no database URL in production', () => {
		process.env.NODE_ENV = 'production';
		expect(demoModeAvailable()).toBe(false);
		privateEnv.ENABLE_DEMO = 'true';
		expect(demoModeAvailable()).toBe(true);
		privateEnv.DATABASE_URL = 'postgres://main-app';
		expect(demoModeAvailable()).toBe(false);
	});

	it('authorizes the synthetic workspace only on the isolated production demo', async () => {
		process.env.NODE_ENV = 'production';
		privateEnv.ENABLE_DEMO = 'true';
		const workspace = { tenant: { slug: 'riverstone' } };
		const getWorkspace = vi.spyOn(store, 'getWorkspace').mockResolvedValue(workspace as never);
		const session = { demo: true, tenantSlug: 'riverstone', role: 'owner' } as never;
		expect(await demoAuthorization(session)).toBe(workspace);
		privateEnv.DATABASE_URL = 'postgres://main-app';
		await expect(demoAuthorization(session)).rejects.toMatchObject({ status: 403 });
		getWorkspace.mockRestore();
	});

	it('starts a signed Riverstone demo session and redirects into the app', async () => {
		process.env.NODE_ENV = 'production';
		privateEnv.ENABLE_DEMO = 'true';
		const set = vi.fn();
		const response = await GET({ cookies: { set } } as never);
		expect(response.status).toBe(303);
		expect(response.headers.get('location')).toBe('/app/riverstone/overview');
		expect(response.headers.get('cache-control')).toBe('no-store');
		expect(set).toHaveBeenCalledOnce();
		const [name, token, options] = set.mock.calls[0];
		expect(name).toBe(cookieName);
		expect(verifySessionToken(token)).toMatchObject({
			userId: 'demo:riverstone',
			tenantSlug: 'riverstone',
			role: 'owner',
			demo: true
		});
		expect(options).toMatchObject({ httpOnly: true, sameSite: 'lax', secure: true, path: '/' });
	});
});

describe('isolated demo request boundaries', () => {
	it('blocks real account creation, credential storage and live provider actions', async () => {
		process.env.NODE_ENV = 'production';
		privateEnv.ENABLE_DEMO = 'true';
		for (const [path, method] of [
			['/api/v1/signup', 'POST'],
			['/api/v1/session', 'POST'],
			['/api/v1/identity/mfa/setup', 'POST'],
			['/api/v1/payments/connect', 'POST'],
			['/api/v1/ai/summary', 'POST'],
			['/api/v1/integrations/ses', 'PUT'],
			['/api/v1/email/send', 'POST'],
			['/api/v1/email/test-send', 'POST'],
			['/api/v1/portal/auth/request', 'POST']
		]) {
			const url = new URL(path, 'https://demo.example.test');
			const resolve = vi.fn();
			const response = await handle({
				event: { url, request: new Request(url, { method }), locals: {} },
				resolve
			} as never);
			expect(response.status, path).toBe(403);
			expect(resolve).not.toHaveBeenCalled();
		}
	});
	it('rejects a signed demo cookie in the real production app', async () => {
		process.env.NODE_ENV = 'production';
		privateEnv.DATABASE_URL = 'postgres://real-app';
		const token = makeSession({
			userId: 'demo:riverstone',
			tenantSlug: 'riverstone',
			role: 'owner',
			demo: true
		});
		const url = new URL('https://give.example.test/app/riverstone/overview');
		const event = {
			url,
			request: new Request(url),
			locals: { session: null },
			cookies: { get: () => token }
		};
		const response = await handle({ event, resolve: vi.fn() } as never);
		expect(response.status).toBe(303);
		expect(event.locals.session).toBeNull();
	});
});

describe('production homepage demo links', () => {
	it('exposes an HTTPS demo link while keeping demo sessions disabled on the database app', () => {
		process.env.NODE_ENV = 'production';
		privateEnv.DATABASE_URL = 'postgres://real-app';
		privateEnv.PUBLIC_DEMO_URL = 'https://demo.example.test/ignored-path';
		expect(homepage()).toMatchObject({
			demoAvailable: false,
			demoUrl: 'https://demo.example.test'
		});
	});
	it('rejects insecure or credential-bearing production demo URLs', () => {
		process.env.NODE_ENV = 'production';
		for (const url of [
			'http://demo.example.test',
			'javascript:alert(1)',
			'https://user:password@demo.example.test'
		]) {
			privateEnv.PUBLIC_DEMO_URL = url;
			expect(homepage().demoUrl).toBeNull();
		}
	});
});
