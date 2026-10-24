import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import argon2 from 'argon2';
import {
	getPool,
	createOwnerAccount,
	authenticate,
	registerSession,
	validateSession,
	workspaceFromPostgres
} from '../src/lib/server/database';
import {
	prepareIdentityTokenMaterial,
	verifyEmailToken,
	handleIdentityEmailOutboxEvent,
	resetPasswordToken,
	requestPasswordReset,
	createTenantInvite,
	acceptTenantInvite,
	createMfaLoginChallenge,
	completeMfaLogin,
	startMfaEnrollment,
	confirmMfaEnrollment,
	verifyTotp,
	listTenantMembers
} from '../src/lib/server/identity';
import { POST as passwordRequestHttp } from '../src/routes/api/v1/identity/password/request/+server';
import { POST as loginHttp } from '../src/routes/api/v1/session/+server';

const enabled =
	Boolean(process.env.DATABASE_URL) && process.env.RUN_POSTGRES_MUTATION_TESTS === 'true';
function decodeBase32(text: string) {
	const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
	let bits = 0,
		value = 0;
	const out: number[] = [];
	for (const ch of text) {
		value = (value << 5) | alphabet.indexOf(ch);
		bits += 5;
		if (bits >= 8) {
			out.push((value >>> (bits - 8)) & 255);
			bits -= 8;
		}
	}
	return Buffer.from(out);
}
function totp(secret: string, now = Date.now()) {
	const counter = Buffer.alloc(8);
	counter.writeBigUInt64BE(BigInt(Math.floor(now / 30000)));
	const digest = createHmac('sha1', decodeBase32(secret)).update(counter).digest();
	const at = digest[digest.length - 1]! & 15;
	return String((digest.readUInt32BE(at) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}
async function outboxEvent(tenantId: string, tokenId: string) {
	const client = await getPool().connect();
	try {
		await client.query('BEGIN');
		await client.query("SELECT set_config('app.tenant_id',$1,true)", [tenantId]);
		const result = await client.query(
			"SELECT event_type,payload FROM outbox_events WHERE tenant_id=$1 AND event_type='identity.email' AND payload->>'tokenId'=$2",
			[tenantId, tokenId]
		);
		await client.query('COMMIT');
		return result.rows[0];
	} catch (error) {
		await client.query('ROLLBACK');
		throw error;
	} finally {
		client.release();
	}
}

describe('identity and staff security flows', () => {
	it(
		'requires verified email, supports one-time recovery, invitations and MFA with recovery codes',
		{ skip: !enabled },
		async () => {
			process.env.CREDENTIAL_VAULT_KEY ||= randomBytes(32).toString('base64');
			process.env.CREDENTIAL_VAULT_KEY_ID ||= 'primary';
			process.env.PUBLIC_APP_URL = 'https://identity-tests.example.test';
			process.env.AWS_REGION = 'us-east-1';
			process.env.AWS_ACCESS_KEY_ID = 'test-key';
			process.env.AWS_SECRET_ACCESS_KEY = 'test-secret';
			process.env.SES_FROM_ADDRESS = 'noreply@example.test';
			const pool = getPool(),
				suffix = randomUUID().replaceAll('-', '').slice(0, 12),
				tenantId = randomUUID(),
				slug = `identity-${suffix}`;
			const tokenMaterial = prepareIdentityTokenMaterial(tenantId, 'verify_email');
			const account = await createOwnerAccount({
				email: `owner-${suffix}@example.test`,
				name: 'Identity Owner',
				passwordHash: await argon2.hash('Initial-secure-password-123', { type: argon2.argon2id }),
				organizationName: `Identity ${suffix}`,
				slug,
				tenantId,
				verification: {
					id: tokenMaterial.id,
					tokenHash: tokenMaterial.tokenHash,
					tokenEnvelope: tokenMaterial.tokenEnvelope,
					expiresAt: new Date(Date.now() + 60_000)
				}
			});
			expect((await authenticate(account.email, slug))?.email_verified_at).toBeNull();
			const cookies = { set: () => {}, delete: () => {}, get: () => undefined };
			const unverifiedLogin = await loginHttp({
				request: new Request('http://localhost/api/v1/session', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({
						email: account.email,
						password: 'Initial-secure-password-123',
						tenant: slug
					})
				}),
				cookies,
				getClientAddress: () => `unverified-${suffix}`
			} as never);
			expect(unverifiedLogin.status).toBe(403);
			expect(await verifyEmailToken(tokenMaterial.token, pool)).toBe(true);
			expect(await verifyEmailToken(tokenMaterial.token, pool)).toBe(false);
			const authenticated = await authenticate(account.email, slug);
			expect(authenticated?.id).toBe(account.userId);
			const sessionId = await registerSession(
				account.userId,
				slug,
				1,
				new Date(Date.now() + 60_000)
			);
			const session = {
				userId: account.userId,
				tenantSlug: slug,
				role: 'owner',
				demo: false,
				sessionId,
				sessionVersion: 1
			};
			expect(await validateSession(session)).toBe(true);
			const knownResponse = await passwordRequestHttp({
				request: new Request('http://localhost/api/v1/identity/password/request', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ email: account.email })
				}),
				getClientAddress: () => `known-${suffix}`
			} as never);
			const unknownResponse = await passwordRequestHttp({
				request: new Request('http://localhost/api/v1/identity/password/request', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ email: `unknown-${suffix}@example.test` })
				}),
				getClientAddress: () => `unknown-${suffix}`
			} as never);
			expect(knownResponse.status).toBe(202);
			expect(unknownResponse.status).toBe(202);
			expect(await knownResponse.text()).toBe(await unknownResponse.text());

			await requestPasswordReset(account.email, pool);
			const client = await pool.connect();
			let resetTokenId = '';
			try {
				await client.query('BEGIN');
				await client.query("SELECT set_config('app.tenant_id',$1,true)", [tenantId]);
				const row = await client.query(
					"SELECT id FROM identity_tokens WHERE tenant_id=$1 AND purpose='password_reset' AND consumed_at IS NULL ORDER BY created_at DESC,id DESC LIMIT 1",
					[tenantId]
				);
				resetTokenId = String(row.rows[0].id);
				await client.query('COMMIT');
			} catch (error) {
				await client.query('ROLLBACK');
				throw error;
			} finally {
				client.release();
			}
			const resetOutbox = await outboxEvent(tenantId, resetTokenId);
			expect(resetOutbox.event_type).toBe('identity.email');
			let resetMessage = '';
			await handleIdentityEmailOutboxEvent(
				{ tenantId, payload: resetOutbox.payload },
				pool,
				async (_tenant, message) => {
					resetMessage = message.text;
					return { id: 'test-mail', status: 'accepted' };
				}
			);
			const resetToken = decodeURIComponent(resetMessage.match(/\?token=([^\s]+)/)?.[1] ?? '');
			expect(resetToken.length).toBeGreaterThan(20);
			const newPassword = await argon2.hash('Replacement-secure-password-456', {
				type: argon2.argon2id
			});
			expect(await resetPasswordToken(resetToken, newPassword, pool)).toBe(true);
			expect(await resetPasswordToken(resetToken, newPassword, pool)).toBe(false);
			expect(await validateSession(session)).toBe(false);
			expect((await authenticate(account.email, slug))?.password_hash).toBe(newPassword);

			const otherSlug = `identity-other-${suffix}`;
			const other = await createOwnerAccount({
				email: `other-${suffix}@example.test`,
				name: 'Other Owner',
				passwordHash: 'fixture-hash',
				organizationName: 'Other Org',
				slug: otherSlug,
				testOnlyVerifiedFixture: true
			});
			await expect(listTenantMembers(tenantId, other.userId, pool)).rejects.toMatchObject({
				status: 403
			});
			const invite = await createTenantInvite({
				tenantId,
				actorId: account.userId,
				email: other.email,
				name: 'Other Owner',
				role: 'analyst',
				pool
			});
			const inviteEvent = await outboxEvent(tenantId, invite.id);
			let inviteText = '';
			await handleIdentityEmailOutboxEvent(
				{ tenantId, payload: inviteEvent.payload },
				pool,
				async (_tenant, message) => {
					inviteText = message.text;
					return { id: 'test-invite-mail', status: 'accepted' };
				}
			);
			const inviteToken = decodeURIComponent(inviteText.match(/\?token=([^\s]+)/)?.[1] ?? '');
			const mismatch = await acceptTenantInvite(
				inviteToken,
				{ existingUser: { id: other.userId, email: 'wrong@example.test' } },
				pool
			);
			expect(mismatch).toMatchObject({ emailMismatch: true });
			const accepted = await acceptTenantInvite(
				inviteToken,
				{ existingUser: { id: other.userId, email: other.email } },
				pool
			);
			expect(accepted).toMatchObject({ tenantSlug: slug, role: 'analyst' });
			expect((await workspaceFromPostgres(slug, other.userId, 'analyst'))?.user.email).toBe(
				other.email
			);
			const reverseInvite = await createTenantInvite({
				tenantId: String(
					(await pool.query('SELECT id FROM tenants WHERE slug=$1', [otherSlug])).rows[0].id
				),
				actorId: other.userId,
				email: account.email,
				name: 'Identity Owner',
				role: 'read_only',
				pool
			});
			const reverseEvent = await outboxEvent(
				String((await pool.query('SELECT id FROM tenants WHERE slug=$1', [otherSlug])).rows[0].id),
				reverseInvite.id
			);
			let reverseText = '';
			await handleIdentityEmailOutboxEvent(
				{
					tenantId: String(
						(await pool.query('SELECT id FROM tenants WHERE slug=$1', [otherSlug])).rows[0].id
					),
					payload: reverseEvent.payload
				},
				pool,
				async (_tenant, message) => {
					reverseText = message.text;
					return { id: 'test-reverse-mail', status: 'accepted' };
				}
			);
			const reverseToken = decodeURIComponent(reverseText.match(/\?token=([^\s]+)/)?.[1] ?? '');
			expect(
				await acceptTenantInvite(
					reverseToken,
					{ existingUser: { id: account.userId, email: account.email } },
					pool
				)
			).toMatchObject({ tenantSlug: otherSlug, role: 'read_only' });

			const setup = await startMfaEnrollment(tenantId, account.userId, account.email, pool);
			const currentCode = totp(setup.secret);
			expect(await verifyTotp(setup.secret, currentCode)).toBe(true);
			const recovery = await confirmMfaEnrollment(tenantId, account.userId, currentCode, pool);
			if (!recovery) throw new Error('MFA recovery codes were not created.');
			expect(recovery).toHaveLength(10);
			const firstLogin = await loginHttp({
				request: new Request('http://localhost/api/v1/session', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({
						email: account.email,
						password: 'Replacement-secure-password-456',
						tenant: slug
					})
				}),
				cookies,
				getClientAddress: () => `login-${suffix}`
			} as never);
			const firstLoginBody = (await firstLogin.json()) as {
				mfaRequired?: boolean;
				challengeToken?: string;
			};
			expect(firstLoginBody.mfaRequired).toBe(true);
			expect(firstLoginBody.challengeToken).toBeTruthy();
			const secondLogin = await loginHttp({
				request: new Request('http://localhost/api/v1/session', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({
						email: account.email,
						password: 'Replacement-secure-password-456',
						tenant: slug,
						mfaChallenge: firstLoginBody.challengeToken,
						mfaCode: totp(setup.secret)
					})
				}),
				cookies,
				getClientAddress: () => `login-${suffix}`
			} as never);
			expect(secondLogin.status).toBe(200);
			const challenge = await createMfaLoginChallenge(slug, account.userId, pool);
			expect(challenge).toBeTruthy();
			expect(await createMfaLoginChallenge(otherSlug, account.userId, pool)).toBeTruthy();
			const loginCode = totp(setup.secret);
			const mfaLogin = await completeMfaLogin(slug, challenge!, loginCode, pool);
			expect(mfaLogin?.userId).toBe(account.userId);
			expect(await completeMfaLogin(slug, challenge!, loginCode, pool)).toBeNull();
			const secondChallenge = await createMfaLoginChallenge(slug, account.userId, pool);
			const recovered = await completeMfaLogin(slug, secondChallenge!, recovery[0]!, pool);
			expect(recovered?.userId).toBe(account.userId);
			const thirdChallenge = await createMfaLoginChallenge(slug, account.userId, pool);
			expect(await completeMfaLogin(slug, thirdChallenge!, recovery[0]!, pool)).toBeNull();
		}
	);

	it('rejects invalid TOTP and malformed base32 secrets', () => {
		expect(verifyTotp('NOT@BASE32', '000000')).rejects.toThrow();
	});
});

afterAll(async () => {
	if (enabled) await getPool().end();
});
