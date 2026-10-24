import { json } from '@sveltejs/kit';
import { workspaceFromPostgres } from '$lib/server/database';
import { getPool } from '$lib/server/database';
import { listTenantMembers } from '$lib/server/identity';
export async function GET({ locals }) {
	const session = locals.session;
	if (!session || session.demo)
		return json({ error: 'Sign in to view workspace members.' }, { status: 401 });
	try {
		const workspace = await workspaceFromPostgres(session.tenantSlug, session.userId, session.role);
		if (!workspace) return json({ error: 'Active membership is unavailable.' }, { status: 403 });
		return json(
			{ members: await listTenantMembers(workspace.tenant.id, session.userId, getPool()) },
			{ headers: { 'cache-control': 'private, no-store' } }
		);
	} catch (error) {
		const status =
			error instanceof Error && 'status' in error
				? Number((error as { status: number }).status)
				: 503;
		return json(
			{
				error:
					status < 500 ? (error as Error).message : 'Identity service is temporarily unavailable.'
			},
			{ status }
		);
	}
}
