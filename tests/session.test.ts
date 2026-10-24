import { describe, expect, it } from 'vitest';
import { makeSession, verifySessionToken } from '../src/hooks.server';

const session = { userId: 'a1', tenantSlug: 'riverstone', role: 'owner', demo: true };

describe('signed sessions', () => {
	it('accepts a signed, unexpired session', () => {
		const token = makeSession(session);
		expect(verifySessionToken(token)).toMatchObject(session);
		expect(verifySessionToken(token)?.expiresAt).toBeGreaterThan(Date.now());
	});

	it('requires database revocation claims for non-demo sessions', () => {
		expect(
			verifySessionToken(
				makeSession({ userId: 'u1', tenantSlug: 'riverstone', role: 'owner', demo: false })
			)
		).toBeNull();
		expect(
			verifySessionToken(
				makeSession({
					userId: 'u1',
					tenantSlug: 'riverstone',
					role: 'owner',
					demo: false,
					sessionId: 's1',
					sessionVersion: 1
				})
			)
		).toMatchObject({ demo: false, sessionId: 's1', sessionVersion: 1 });
	});

	it('rejects a tampered signature and expired session', () => {
		const token = makeSession(session);
		expect(verifySessionToken(`${token.slice(0, -1)}x`)).toBeNull();
		expect(verifySessionToken(`${token}.suffix`)).toBeNull();
		expect(verifySessionToken(makeSession(session, -1))).toBeNull();
	});
});
