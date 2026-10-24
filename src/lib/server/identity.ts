import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { env } from '$env/dynamic/private';
import { credentialVaultFromEnvironment } from '$lib/providers/vault.server';
import { getPool } from './database';

export type IdentityPurpose = 'verify_email' | 'password_reset' | 'invite';
export type IdentityOutboxEvent = { tenantId: string; payload: unknown };
type MailSender = (
	tenantId: string,
	input: { to: string; name: string; subject: string; text: string; idempotencyKey: string },
	pool?: Pool
) => Promise<{ id: string; status: 'accepted' | 'already_accepted' | 'uncertain' }>;

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const equalHex = (a: string, b: string) => {
	try {
		const x = Buffer.from(a, 'hex');
		const y = Buffer.from(b, 'hex');
		return x.length === y.length && timingSafeEqual(x, y);
	} catch {
		return false;
	}
};
const tokenVault = () => credentialVaultFromEnvironment();
export function prepareIdentityTokenMaterial(tenantId: string, purpose: IdentityPurpose) {
	const id = randomUUID();
	const token = randomBytes(32).toString('base64url');
	return {
		id,
		token,
		tokenHash: hash(token),
		tokenEnvelope: tokenVault().encrypt(
			{ tenantId, provider: 'identity', credentialId: id },
			token
		),
		purpose
	};
}

async function scoped<T>(pool: Pool, tenantId: string, action: (client: PoolClient) => Promise<T>) {
	const client = await pool.connect();
	try {
		await client.query('BEGIN');
		await client.query("SELECT set_config('app.tenant_id',$1,true)", [tenantId]);
		const value = await action(client);
		await client.query('COMMIT');
		return value;
	} catch (error) {
		await client.query('ROLLBACK').catch(() => undefined);
		throw error;
	} finally {
		client.release();
	}
}

/** Creates an encrypted, single-use delivery token and a durable outbox event atomically. */
export async function issueIdentityToken(input: {
	tenantId: string;
	userId?: string | null;
	actorId?: string | null;
	purpose: IdentityPurpose;
	email: string;
	name: string;
	metadata?: Record<string, unknown>;
	expiresInMs?: number;
	pool?: Pool;
}) {
	const pool = input.pool ?? getPool();
	const id = randomUUID();
	const token = randomBytes(32).toString('base64url');
	const tokenHash = hash(token);
	const envelope = tokenVault().encrypt(
		{ tenantId: input.tenantId, provider: 'identity', credentialId: id },
		token
	);
	await scoped(pool, input.tenantId, async (client) => {
		await client.query(
			"UPDATE identity_tokens SET consumed_at=now(),token_envelope='' WHERE tenant_id=$1 AND purpose=$2 AND lower(email)=lower($3) AND consumed_at IS NULL",
			[input.tenantId, input.purpose, input.email]
		);
		await client.query(
			`INSERT INTO identity_tokens(id,tenant_id,user_id,actor_id,purpose,email,token_hash,token_envelope,metadata,expires_at)
			 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
			[
				id,
				input.tenantId,
				input.userId ?? null,
				input.actorId ?? null,
				input.purpose,
				input.email.toLowerCase(),
				tokenHash,
				envelope,
				{ name: input.name, ...(input.metadata ?? {}) },
				new Date(Date.now() + (input.expiresInMs ?? 60 * 60 * 1000))
			]
		);
		await client.query(
			"INSERT INTO outbox_events(tenant_id,event_type,payload,idempotency_key) VALUES($1,'identity.email',$2,$3)",
			[input.tenantId, { tokenId: id }, `identity:${id}`]
		);
	});
	return { id, token };
}

/** Worker entry point. The raw token is decrypted only in the worker process and never logged. */
export async function handleIdentityEmailOutboxEvent(
	event: IdentityOutboxEvent,
	pool: Pool,
	send: MailSender
) {
	const payload = event.payload as { tokenId?: unknown };
	if (typeof payload?.tokenId !== 'string' || !/^[0-9a-f-]{36}$/i.test(payload.tokenId))
		throw new Error('Identity email event is invalid.');
	const row = await scoped(pool, event.tenantId, async (client) => {
		const result = await client.query(
			`SELECT id,purpose,email,metadata,token_envelope,expires_at,delivery_status
			 FROM identity_tokens WHERE tenant_id=$1 AND id=$2 AND consumed_at IS NULL AND expires_at>now()`,
			[event.tenantId, payload.tokenId]
		);
		return result.rows[0] as
			| {
					id: string;
					purpose: IdentityPurpose;
					email: string;
					metadata: Record<string, unknown>;
					token_envelope: string;
					expires_at: Date;
					delivery_status: string;
			  }
			| undefined;
	});
	if (!row || row.delivery_status !== 'pending') return;
	const token = tokenVault().decrypt(
		{ tenantId: event.tenantId, provider: 'identity', credentialId: row.id },
		row.token_envelope
	);
	const base = (env.PUBLIC_APP_URL || process.env.PUBLIC_APP_URL || '').replace(/\/$/, '');
	if (
		!base ||
		(process.env.NODE_ENV === 'production'
			? !/^https:\/\//i.test(base)
			: !/^https?:\/\//i.test(base))
	)
		throw new Error('PUBLIC_APP_URL must be configured with HTTPS for identity mail.');
	const paths: Record<IdentityPurpose, string> = {
		verify_email: '/account/verify',
		password_reset: '/account/recover',
		invite: '/account/invite'
	};
	const purposeText: Record<IdentityPurpose, string> = {
		verify_email: 'Confirm your email address',
		password_reset: 'Reset your password',
		invite: 'Accept your workspace invitation'
	};
	const result = await send(
		event.tenantId,
		{
			to: row.email,
			name: String(row.metadata?.name ?? ''),
			subject: purposeText[row.purpose],
			text: `${purposeText[row.purpose]}: ${base}${paths[row.purpose]}?token=${encodeURIComponent(token)}\n\nThis link expires soon and can be used once. If you did not request it, you can ignore this message.`,
			idempotencyKey: `identity:${row.id}`
		},
		pool
	);
	await scoped(pool, event.tenantId, async (client) => {
		await client.query(
			`UPDATE identity_tokens SET delivery_status=$3,sent_at=CASE WHEN $3='sent' THEN now() ELSE sent_at END,token_envelope=''
			 WHERE tenant_id=$1 AND id=$2 AND delivery_status='pending'`,
			[event.tenantId, row.id, result.status === 'uncertain' ? 'uncertain' : 'sent']
		);
	});
}

export async function verifyEmailToken(token: string, pool = getPool()) {
	return consumeSimpleToken(token, 'verify_email', pool, async (client, row) => {
		if (!row.user_id) return false;
		await client.query('UPDATE users SET email_verified_at=now() WHERE id=$1 AND email=$2', [
			row.user_id,
			row.email
		]);
		await client.query(
			"INSERT INTO audit_log(tenant_id,actor_id,action,resource,record_id,details) VALUES($1,$2,'identity.email_verified','user',$2,'{}')",
			[row.tenant_id, row.user_id]
		);
		return true;
	});
}

export async function resetPasswordToken(token: string, passwordHash: string, pool = getPool()) {
	return consumeSimpleToken(token, 'password_reset', pool, async (client, row) => {
		if (!row.user_id) return false;
		const result = await client.query(
			'UPDATE users SET password_hash=$2,session_version=session_version+1 WHERE id=$1 AND email=$3 AND disabled_at IS NULL',
			[row.user_id, passwordHash, row.email]
		);
		if (!result.rowCount) return false;
		await client.query(
			'UPDATE auth_sessions SET revoked_at=now() WHERE tenant_id=$1 AND user_id=$2 AND revoked_at IS NULL',
			[row.tenant_id, row.user_id]
		);
		await client.query(
			"INSERT INTO audit_log(tenant_id,actor_id,action,resource,record_id,details) VALUES($1,$2,'identity.password_reset','user',$2,'{}')",
			[row.tenant_id, row.user_id]
		);
		return true;
	});
}

async function consumeSimpleToken(
	token: string,
	purpose: IdentityPurpose,
	pool: Pool,
	action: (
		client: PoolClient,
		row: { tenant_id: string; user_id: string | null; email: string }
	) => Promise<boolean>
) {
	if (!token || token.length > 256) return false;
	const digest = hash(token);
	const tenants = await pool.query<{ id: string }>('SELECT id FROM tenants ORDER BY id');
	for (const tenant of tenants.rows) {
		const consumed = await scoped(pool, tenant.id, async (client) => {
			const selected = await client.query<{
				tenant_id: string;
				user_id: string | null;
				email: string;
			}>(
				`SELECT tenant_id,user_id,email FROM identity_tokens WHERE tenant_id=$1 AND purpose=$2 AND token_hash=$3 AND consumed_at IS NULL AND expires_at>now() FOR UPDATE`,
				[tenant.id, purpose, digest]
			);
			const row = selected.rows[0];
			if (!row) return false;
			if (!(await action(client, row))) return false;
			await client.query(
				"UPDATE identity_tokens SET consumed_at=now(),token_envelope='' WHERE tenant_id=$1 AND token_hash=$2",
				[tenant.id, digest]
			);
			return true;
		});
		if (consumed) return true;
	}
	return false;
}

export async function requestPasswordReset(email: string, pool = getPool()) {
	const normalized = email.trim().toLowerCase();
	if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized) || normalized.length > 254) return;
	const tenants = await pool.query<{ id: string; slug: string }>(
		'SELECT id,slug FROM tenants ORDER BY id'
	);
	for (const tenant of tenants.rows) {
		const user = await scoped(pool, tenant.id, async (client) => {
			const result = await client.query<{
				id: string;
				display_name: string;
				email_verified_at: Date | null;
			}>(
				"SELECT u.id,u.display_name,u.email_verified_at FROM users u JOIN memberships m ON m.user_id=u.id WHERE lower(u.email)=lower($1) AND m.tenant_id=$2 AND m.status='active' AND u.disabled_at IS NULL",
				[normalized, tenant.id]
			);
			return result.rows[0];
		});
		if (user?.email_verified_at) {
			await issueIdentityToken({
				tenantId: tenant.id,
				userId: user.id,
				purpose: 'password_reset',
				email: normalized,
				name: user.display_name,
				expiresInMs: 30 * 60 * 1000,
				pool
			});
			return;
		}
	}
}

export async function issueVerificationForAccount(
	tenantId: string,
	userId: string,
	email: string,
	name: string,
	pool = getPool()
) {
	return issueIdentityToken({
		tenantId,
		userId,
		purpose: 'verify_email',
		email,
		name,
		expiresInMs: 24 * 60 * 60 * 1000,
		pool
	});
}

export async function requestEmailVerification(
	email: string,
	tenantSlug: string,
	pool = getPool()
) {
	const tenant = await pool.query<{ id: string }>('SELECT id FROM tenants WHERE slug=$1', [
		tenantSlug
	]);
	if (!tenant.rowCount) return;
	const user = await scoped(pool, tenant.rows[0]!.id, async (client) => {
		const result = await client.query<{
			id: string;
			email: string;
			display_name: string;
			email_verified_at: Date | null;
		}>(
			`SELECT u.id,u.email,u.display_name,u.email_verified_at FROM users u JOIN memberships m ON m.user_id=u.id WHERE m.tenant_id=$1 AND lower(u.email)=lower($2) AND m.status='active' AND u.disabled_at IS NULL`,
			[tenant.rows[0]!.id, email.trim().toLowerCase()]
		);
		return result.rows[0];
	});
	if (user && !user.email_verified_at)
		await issueVerificationForAccount(
			tenant.rows[0]!.id,
			user.id,
			user.email,
			user.display_name,
			pool
		);
}

export async function createTenantInvite(input: {
	tenantId: string;
	actorId: string;
	email: string;
	name: string;
	role: string;
	pool?: Pool;
}) {
	const pool = input.pool ?? getPool();
	if (
		![
			'admin',
			'finance_manager',
			'fundraiser',
			'marketer',
			'finance',
			'donor',
			'analyst',
			'volunteer',
			'board_member',
			'read_only'
		].includes(input.role)
	)
		throw new Error('Choose an assignable member role.');
	const allowed = await scoped(pool, input.tenantId, async (client) => {
		const row = await client.query(
			"SELECT role FROM memberships WHERE tenant_id=$1 AND user_id=$2 AND status='active'",
			[input.tenantId, input.actorId]
		);
		return ['owner', 'admin'].includes(row.rows[0]?.role);
	});
	if (!allowed)
		throw Object.assign(new Error('Only owners and admins can invite staff.'), { status: 403 });
	const token = await issueIdentityToken({
		tenantId: input.tenantId,
		actorId: input.actorId,
		purpose: 'invite',
		email: input.email,
		name: input.name,
		metadata: { name: input.name, role: input.role },
		expiresInMs: 7 * 24 * 60 * 60 * 1000,
		pool
	});
	return {
		id: token.id,
		email: input.email.toLowerCase(),
		role: input.role,
		expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
	};
}

export async function listTenantInvites(tenantId: string, actorId: string, pool = getPool()) {
	return scoped(pool, tenantId, async (client) => {
		const actor = await client.query(
			"SELECT role FROM memberships WHERE tenant_id=$1 AND user_id=$2 AND status='active'",
			[tenantId, actorId]
		);
		if (!['owner', 'admin'].includes(actor.rows[0]?.role))
			throw Object.assign(new Error('Only owners and admins can manage invitations.'), {
				status: 403
			});
		const result = await client.query(
			`SELECT id,email,metadata->>'role' AS role,created_at AS "createdAt",expires_at AS "expiresAt",delivery_status AS "deliveryStatus" FROM identity_tokens WHERE tenant_id=$1 AND purpose='invite' AND consumed_at IS NULL AND expires_at>now() ORDER BY created_at DESC`,
			[tenantId]
		);
		return result.rows;
	});
}
export async function listTenantMembers(tenantId: string, actorId: string, pool = getPool()) {
	return scoped(pool, tenantId, async (client) => {
		const actor = await client.query(
			"SELECT role FROM memberships WHERE tenant_id=$1 AND user_id=$2 AND status='active'",
			[tenantId, actorId]
		);
		if (!['owner', 'admin'].includes(actor.rows[0]?.role))
			throw Object.assign(new Error('Only owners and admins can view member details.'), {
				status: 403
			});
		const result = await client.query(
			`SELECT u.id,u.display_name AS name,u.email,m.role,m.created_at AS "joinedAt" FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.tenant_id=$1 AND m.status='active' ORDER BY u.display_name`,
			[tenantId]
		);
		return result.rows;
	});
}
export async function revokeTenantInvite(
	tenantId: string,
	actorId: string,
	inviteId: string,
	pool = getPool()
) {
	return scoped(pool, tenantId, async (client) => {
		const actor = await client.query(
			"SELECT role FROM memberships WHERE tenant_id=$1 AND user_id=$2 AND status='active'",
			[tenantId, actorId]
		);
		if (!['owner', 'admin'].includes(actor.rows[0]?.role))
			throw Object.assign(new Error('Only owners and admins can revoke invitations.'), {
				status: 403
			});
		const result = await client.query(
			"UPDATE identity_tokens SET consumed_at=now(),token_envelope='' WHERE tenant_id=$1 AND id=$2 AND purpose='invite' AND consumed_at IS NULL",
			[tenantId, inviteId]
		);
		return Boolean(result.rowCount);
	});
}

export async function acceptTenantInvite(
	token: string,
	input: { name?: string; passwordHash?: string; existingUser?: { id: string; email: string } },
	pool = getPool()
) {
	if (!token || token.length > 256) return null;
	const digest = hash(token);
	const tenants = await pool.query<{ id: string }>('SELECT id FROM tenants ORDER BY id');
	for (const tenant of tenants.rows) {
		const accepted = await scoped(pool, tenant.id, async (client) => {
			const query = await client.query<{
				id: string;
				email: string;
				metadata: Record<string, unknown>;
			}>(
				`SELECT id,email,metadata FROM identity_tokens WHERE tenant_id=$1 AND purpose='invite' AND token_hash=$2 AND consumed_at IS NULL AND expires_at>now() FOR UPDATE`,
				[tenant.id, digest]
			);
			const invite = query.rows[0];
			if (!invite) return null;
			const role = String(invite.metadata.role ?? 'read_only');
			let userId: string;
			if (input.existingUser) {
				if (input.existingUser.email.trim().toLowerCase() !== invite.email)
					return { emailMismatch: true as const };
				userId = input.existingUser.id;
				await client.query(
					"INSERT INTO memberships(tenant_id,user_id,role,status) VALUES($1,$2,$3,'active') ON CONFLICT(tenant_id,user_id) DO UPDATE SET role=EXCLUDED.role,status='active'",
					[tenant.id, userId, role]
				);
			} else {
				if (!input.name || !input.passwordHash) return null;
				userId = randomUUID();
				await client.query("SELECT set_config('app.signup_user_id',$1,true)", [userId]);
				let inserted;
				try {
					inserted = await client.query(
						'INSERT INTO users(id,email,display_name,password_hash,email_verified_at) VALUES($1,$2,$3,$4,now()) RETURNING id',
						[userId, invite.email, input.name.trim(), input.passwordHash]
					);
				} catch (error) {
					if ((error as { code?: string }).code === '23505') return { existing: true as const };
					throw error;
				}
				await client.query("SELECT set_config('app.signup_user_id','',true)");
				await client.query(
					"INSERT INTO memberships(tenant_id,user_id,role,status) VALUES($1,$2,$3,'active')",
					[tenant.id, inserted.rows[0]!.id, role]
				);
			}
			await client.query(
				"UPDATE identity_tokens SET consumed_at=now(),token_envelope='' WHERE tenant_id=$1 AND id=$2",
				[tenant.id, invite.id]
			);
			await client.query(
				"INSERT INTO audit_log(tenant_id,actor_id,action,resource,record_id,details) VALUES($1,$2,'identity.invite_accepted','membership',$2,$3)",
				[tenant.id, userId, { role }]
			);
			const t = await client.query<{ slug: string }>('SELECT slug FROM tenants WHERE id=$1', [
				tenant.id
			]);
			const member = await client.query<{ session_version: number }>(
				'SELECT session_version FROM users WHERE id=$1',
				[userId]
			);
			return {
				userId,
				tenantSlug: t.rows[0]!.slug,
				role,
				sessionVersion: member.rows[0]?.session_version ?? 1,
				existing: false as const
			};
		});
		if (accepted) return accepted;
	}
	return null;
}

export async function changeMemberRole(
	tenantId: string,
	actorId: string,
	userId: string,
	role: string,
	pool = getPool()
) {
	const roles = [
		'admin',
		'finance_manager',
		'fundraiser',
		'marketer',
		'finance',
		'donor',
		'analyst',
		'volunteer',
		'board_member',
		'read_only'
	];
	if (!roles.includes(role)) throw new Error('Choose a valid member role.');
	return scoped(pool, tenantId, async (client) => {
		const actor = await client.query(
			"SELECT role FROM memberships WHERE tenant_id=$1 AND user_id=$2 AND status='active'",
			[tenantId, actorId]
		);
		if (!['owner', 'admin'].includes(actor.rows[0]?.role))
			throw Object.assign(new Error('Member role change is not permitted.'), { status: 403 });
		const target = await client.query<{ role: string }>(
			"SELECT role FROM memberships WHERE tenant_id=$1 AND user_id=$2 AND status='active' FOR UPDATE",
			[tenantId, userId]
		);
		if (!target.rowCount) throw Object.assign(new Error('Member not found.'), { status: 404 });
		if (target.rows[0]!.role === 'owner' && role !== 'owner') {
			const owners = await client.query(
				"SELECT count(*)::int AS n FROM memberships WHERE tenant_id=$1 AND role='owner' AND status='active'",
				[tenantId]
			);
			if (owners.rows[0]!.n <= 1)
				throw Object.assign(new Error('A workspace must retain at least one owner.'), {
					status: 409
				});
		}
		await client.query('UPDATE memberships SET role=$3 WHERE tenant_id=$1 AND user_id=$2', [
			tenantId,
			userId,
			role
		]);
		await client.query(
			"INSERT INTO audit_log(tenant_id,actor_id,action,resource,record_id,details) VALUES($1,$2,'identity.role_changed','membership',$3,$4)",
			[tenantId, actorId, userId, { role }]
		);
		return true;
	});
}

export async function listStaffSessions(
	tenantId: string,
	userId: string,
	currentSessionId: string,
	pool = getPool()
) {
	return scoped(pool, tenantId, async (client) => {
		const result = await client.query(
			`SELECT id,created_at AS "createdAt",last_seen_at AS "lastSeenAt",expires_at AS "expiresAt",(id=$3) AS current FROM auth_sessions WHERE tenant_id=$1 AND user_id=$2 AND revoked_at IS NULL AND expires_at>now() ORDER BY created_at DESC`,
			[tenantId, userId, currentSessionId]
		);
		return result.rows;
	});
}
export async function revokeStaffSession(
	tenantId: string,
	userId: string,
	sessionId: string,
	pool = getPool()
) {
	return scoped(pool, tenantId, async (client) => {
		const result = await client.query(
			'UPDATE auth_sessions SET revoked_at=now() WHERE tenant_id=$1 AND user_id=$2 AND id=$3 AND revoked_at IS NULL',
			[tenantId, userId, sessionId]
		);
		return Boolean(result.rowCount);
	});
}

export async function startMfaEnrollment(
	tenantId: string,
	userId: string,
	email: string,
	pool = getPool()
) {
	const secret = generateTotpSecret();
	const envelope = tokenVault().encrypt(
		{ tenantId: 'identity-global', provider: 'identity-mfa', credentialId: userId },
		secret
	);
	await scoped(pool, tenantId, async (client) => {
		const current = await client.query('SELECT enabled_at FROM identity_mfa WHERE user_id=$1', [
			userId
		]);
		if (current.rows[0]?.enabled_at)
			throw Object.assign(new Error('MFA is already enabled.'), { status: 409 });
		await client.query(
			`INSERT INTO identity_mfa(user_id,pending_secret_envelope) VALUES($1,$2) ON CONFLICT(user_id) DO UPDATE SET pending_secret_envelope=EXCLUDED.pending_secret_envelope,updated_at=now()`,
			[userId, envelope]
		);
	});
	const label = encodeURIComponent(email);
	return {
		secret,
		otpauthUri: `otpauth://totp/Giveloom:${label}?secret=${secret}&issuer=Giveloom&algorithm=SHA1&digits=6&period=30`
	};
}
export async function getMfaStatus(tenantId: string, userId: string, pool = getPool()) {
	return scoped(pool, tenantId, async (client) => {
		const result = await client.query(
			'SELECT enabled_at IS NOT NULL AS enabled FROM identity_mfa WHERE user_id=$1',
			[userId]
		);
		return Boolean(result.rows[0]?.enabled);
	});
}
export async function confirmMfaEnrollment(
	tenantId: string,
	userId: string,
	code: string,
	pool = getPool()
) {
	return scoped(pool, tenantId, async (client) => {
		const result = await client.query<{ pending_secret_envelope: string | null }>(
			'SELECT pending_secret_envelope FROM identity_mfa WHERE user_id=$1 FOR UPDATE',
			[userId]
		);
		const envelope = result.rows[0]?.pending_secret_envelope;
		if (!envelope) return null;
		const secret = tokenVault().decrypt(
			{ tenantId: 'identity-global', provider: 'identity-mfa', credentialId: userId },
			envelope
		);
		if (!(await verifyTotp(secret, code))) return null;
		const recovery = Array.from({ length: 10 }, () =>
			randomBytes(8)
				.toString('hex')
				.toUpperCase()
				.match(/.{1,4}/g)!
				.join('-')
		);
		await client.query(
			'UPDATE identity_mfa SET secret_envelope=pending_secret_envelope,pending_secret_envelope=NULL,recovery_hashes=$2,enabled_at=now(),updated_at=now() WHERE user_id=$1',
			[userId, recovery.map(hash)]
		);
		await client.query(
			"INSERT INTO audit_log(tenant_id,actor_id,action,resource,record_id,details) VALUES($1,$2,'identity.mfa_enabled','user',$2,'{}')",
			[tenantId, userId]
		);
		return recovery;
	});
}
export async function disableMfa(tenantId: string, userId: string, code: string, pool = getPool()) {
	return scoped(pool, tenantId, async (client) => {
		const result = await client.query<{
			secret_envelope: string | null;
			recovery_hashes: string[];
		}>(
			'SELECT secret_envelope,recovery_hashes FROM identity_mfa WHERE user_id=$1 AND enabled_at IS NOT NULL FOR UPDATE',
			[userId]
		);
		const row = result.rows[0];
		if (!row?.secret_envelope) return false;
		const secret = tokenVault().decrypt(
			{ tenantId: 'identity-global', provider: 'identity-mfa', credentialId: userId },
			row.secret_envelope
		);
		let valid = await verifyTotp(secret, code);
		if (!valid) valid = row.recovery_hashes.some((x) => equalHex(x, hash(code.toUpperCase())));
		if (!valid) return false;
		await client.query('DELETE FROM identity_mfa WHERE user_id=$1', [userId]);
		return true;
	});
}
export async function createMfaLoginChallenge(
	tenantSlug: string,
	userId: string,
	pool = getPool()
) {
	const tenant = await pool.query<{ id: string }>('SELECT id FROM tenants WHERE slug=$1', [
		tenantSlug
	]);
	if (!tenant.rowCount) return null;
	const raw = randomBytes(32).toString('base64url');
	const found = await scoped(pool, tenant.rows[0]!.id, async (client) => {
		const row = await client.query(
			'SELECT 1 FROM identity_mfa WHERE user_id=$1 AND enabled_at IS NOT NULL',
			[userId]
		);
		if (!row.rowCount) return false;
		await client.query(
			"INSERT INTO identity_mfa_challenges(tenant_id,user_id,challenge_hash,expires_at) VALUES($1,$2,$3,now()+interval '5 minutes')",
			[tenant.rows[0]!.id, userId, hash(raw)]
		);
		return true;
	});
	return found ? raw : null;
}
export async function completeMfaLogin(
	tenantSlug: string,
	challengeToken: string,
	code: string,
	pool = getPool()
) {
	const tenant = await pool.query<{ id: string }>('SELECT id FROM tenants WHERE slug=$1', [
		tenantSlug
	]);
	if (!tenant.rowCount || challengeToken.length > 256) return null;
	const tenantId = tenant.rows[0]!.id;
	const digest = hash(challengeToken);
	return scoped(pool, tenantId, async (client) => {
		const challenge = await client.query<{ user_id: string }>(
			'SELECT user_id FROM identity_mfa_challenges WHERE tenant_id=$1 AND challenge_hash=$2 AND consumed_at IS NULL AND expires_at>now() FOR UPDATE',
			[tenantId, digest]
		);
		const userId = challenge.rows[0]?.user_id;
		if (!userId) return null;
		const mfa = await client.query<{ secret_envelope: string | null; recovery_hashes: string[] }>(
			'SELECT secret_envelope,recovery_hashes FROM identity_mfa WHERE user_id=$1 AND enabled_at IS NOT NULL FOR UPDATE',
			[userId]
		);
		const row = mfa.rows[0];
		if (!row?.secret_envelope) return null;
		const secret = tokenVault().decrypt(
			{ tenantId: 'identity-global', provider: 'identity-mfa', credentialId: userId },
			row.secret_envelope
		);
		let valid = await verifyTotp(secret, code);
		if (!valid) {
			const at = row.recovery_hashes.findIndex((x) => equalHex(x, hash(code.toUpperCase())));
			if (at >= 0) {
				row.recovery_hashes.splice(at, 1);
				await client.query(
					'UPDATE identity_mfa SET recovery_hashes=$2,updated_at=now() WHERE user_id=$1',
					[userId, row.recovery_hashes]
				);
				valid = true;
			}
		}
		if (!valid) return null;
		await client.query(
			'UPDATE identity_mfa_challenges SET consumed_at=now() WHERE tenant_id=$1 AND challenge_hash=$2',
			[tenantId, digest]
		);
		const user = await client.query<{ role: string; session_version: number }>(
			"SELECT m.role,u.session_version FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.tenant_id=$1 AND m.user_id=$2 AND m.status='active' AND u.disabled_at IS NULL AND u.email_verified_at IS NOT NULL",
			[tenantId, userId]
		);
		if (!user.rowCount) return null;
		return { userId, role: user.rows[0]!.role, sessionVersion: user.rows[0]!.session_version };
	});
}

export async function verifyTotp(secretBase32: string, code: string, now = Date.now()) {
	if (!/^\d{6}$/.test(code)) return false;
	const secret = decodeBase32(secretBase32);
	for (let offset = -1; offset <= 1; offset++) {
		const counter = Buffer.alloc(8);
		counter.writeBigUInt64BE(BigInt(Math.floor(now / 30000) + offset));
		const digest = createHmac('sha1', secret).update(counter).digest();
		const at = digest[digest.length - 1]! & 15;
		const value = ((digest.readUInt32BE(at) & 0x7fffffff) % 1_000_000).toString().padStart(6, '0');
		if (equalHex(Buffer.from(value).toString('hex'), Buffer.from(code).toString('hex')))
			return true;
	}
	return false;
}

function decodeBase32(value: string) {
	const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
	let bits = 0,
		buffer = 0;
	const out: number[] = [];
	for (const char of value.toUpperCase().replace(/=+$/, '')) {
		const digit = alphabet.indexOf(char);
		if (digit < 0) throw new Error('Invalid TOTP secret.');
		buffer = (buffer << 5) | digit;
		bits += 5;
		if (bits >= 8) {
			out.push((buffer >>> (bits - 8)) & 255);
			bits -= 8;
		}
	}
	return Buffer.from(out);
}

export function generateTotpSecret() {
	const bytes = randomBytes(20);
	const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
	let bits = 0,
		value = 0,
		out = '';
	for (const byte of bytes) {
		value = (value << 8) | byte;
		bits += 8;
		while (bits >= 5) {
			out += alphabet[(value >>> (bits - 5)) & 31];
			bits -= 5;
		}
	}
	if (bits) out += alphabet[(value << (5 - bits)) & 31];
	return out;
}

export function identityTokenDigest(token: string) {
	return hash(token);
}
