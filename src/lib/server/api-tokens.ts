import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { getPool, workspaceFromPostgres } from './database';
import { authRateLimit } from './auth-rate-limit';
import {
	ServiceError,
	serviceAudit,
	tenantTransaction,
	type TenantSession
} from './tenant-service';

const ownerRoles = ['owner', 'admin'] as const;
const permissionSchema = z.enum(['contacts:read', 'giving:read', 'giving:write']);
const tokenCreateSchema = z
	.object({
		label: z.string().trim().min(1).max(120),
		permissions: z
			.array(permissionSchema)
			.min(1)
			.max(3)
			.refine((items) => new Set(items).size === items.length),
		expiresAt: z.string().datetime().optional()
	})
	.strict();

export class ApiTokenError extends Error {
	constructor(
		message: string,
		readonly status: number
	) {
		super(message);
		this.name = 'ApiTokenError';
	}
}

async function requireAdmin(session: TenantSession) {
	if (!session || session.demo) throw new ApiTokenError('Sign in to manage API tokens.', 401);
	const workspace = await workspaceFromPostgres(session.tenantSlug, session.userId, session.role);
	if (!workspace) throw new ApiTokenError('Active workspace membership is unavailable.', 403);
	if (!ownerRoles.includes(workspace.user.role as (typeof ownerRoles)[number]))
		throw new ApiTokenError('Only tenant owners and administrators can manage API tokens.', 403);
	return workspace;
}

export async function listApiTokens(session: TenantSession) {
	await requireAdmin(session);
	return tenantTransaction(session, ownerRoles, async (client, tenant) => {
		const rows = await client.query(
			`SELECT id,label,token_prefix AS "tokenPrefix",permissions,created_at AS "createdAt",
			last_used_at AS "lastUsedAt",expires_at AS "expiresAt",revoked_at AS "revokedAt"
			FROM api_tokens WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 100`,
			[tenant.id]
		);
		await serviceAudit(client, tenant.id, session.userId, 'api_token.list', 'api_tokens');
		return { tokens: rows.rows };
	});
}

export async function createApiToken(session: TenantSession, input: unknown) {
	const data = tokenCreateSchema.parse(input);
	if (data.expiresAt && Date.parse(data.expiresAt) <= Date.now())
		throw new ApiTokenError('Expiration must be in the future.', 422);
	await requireAdmin(session);
	const id = randomUUID();
	const rawToken = `gl_pat_${randomBytes(32).toString('base64url')}`;
	const tokenHash = createHash('sha256').update(rawToken).digest('hex');
	const tokenPrefix = rawToken.slice(0, 15);
	return tenantTransaction(session, ownerRoles, async (client, tenant) => {
		await client.query(
			'INSERT INTO api_tokens(tenant_id,id,label,token_prefix,token_hash,permissions,created_by,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
			[
				tenant.id,
				id,
				data.label,
				tokenPrefix,
				tokenHash,
				data.permissions,
				session.userId,
				data.expiresAt ?? null
			]
		);
		await serviceAudit(client, tenant.id, session.userId, 'api_token.create', 'api_tokens', id, {
			permissions: data.permissions
		});
		return {
			token: rawToken,
			item: {
				id,
				label: data.label,
				tokenPrefix,
				permissions: data.permissions,
				expiresAt: data.expiresAt ?? null
			}
		};
	});
}

export async function revokeApiToken(session: TenantSession, tokenId: string) {
	const id = z.string().uuid().parse(tokenId);
	await requireAdmin(session);
	return tenantTransaction(session, ownerRoles, async (client, tenant) => {
		const result = await client.query(
			'UPDATE api_tokens SET revoked_at=coalesce(revoked_at,now()) WHERE tenant_id=$1 AND id=$2 RETURNING id',
			[tenant.id, id]
		);
		if (!result.rowCount) throw new ApiTokenError('API token not found in this workspace.', 404);
		await serviceAudit(client, tenant.id, session.userId, 'api_token.revoke', 'api_tokens', id);
		return { revoked: true };
	});
}

export type ApiPermission = z.infer<typeof permissionSchema>;
export async function authenticateApiToken(rawToken: string, permission: ApiPermission) {
	if (!/^gl_pat_[A-Za-z0-9_-]{40,80}$/.test(rawToken))
		throw new ApiTokenError('API token is invalid or expired.', 401);
	const hash = createHash('sha256').update(rawToken).digest('hex');
	const lookup = await getPool().query<{
		token_id: string;
		tenant_id: string;
		tenant_slug: string;
		created_by: string;
		permissions: string[];
	}>(' SELECT token_id,tenant_id,tenant_slug,created_by,permissions FROM lookup_api_token($1)', [
		hash
	]);
	const token = lookup.rows[0];
	if (!token) throw new ApiTokenError('API token is invalid or expired.', 401);
	if (!token.permissions.includes(permission))
		throw new ApiTokenError(
			'API token does not include the permission required for this endpoint.',
			403
		);
	const limit = await authRateLimit('api', token.tenant_id, 600, 60);
	if (!limit.available)
		throw new ApiTokenError('API rate limiting is temporarily unavailable.', 503);
	if (!limit.allowed)
		throw new ApiTokenError('Workspace API rate limit reached. Try again shortly.', 429);
	return {
		userId: token.created_by,
		tenantSlug: token.tenant_slug,
		role: 'api',
		demo: false
	} as TenantSession;
}

export async function resolveApiSession(
	request: Request,
	session: TenantSession | null,
	permission: ApiPermission
) {
	if (session) return session;
	const authorization = request.headers.get('authorization') || '';
	const match = /^Bearer\s+(\S+)$/i.exec(authorization);
	if (!match) throw new ApiTokenError('Sign in or provide a bearer API token.', 401);
	return authenticateApiToken(match[1], permission);
}

export function apiTokenResponseError(error: unknown) {
	if (error instanceof ApiTokenError) return { status: error.status, error: error.message };
	if (error instanceof z.ZodError) return { status: 422, error: 'API token request is invalid.' };
	const code = String((error as { code?: unknown })?.code || '');
	return {
		status: code === '23505' ? 409 : 503,
		error: 'API token service is temporarily unavailable.'
	};
}
