import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { workspaceFromPostgres } from '$lib/server/database';
import { revokeTenantInvite } from '$lib/server/identity';
export async function DELETE({ params, locals }) {
	const session = locals.session;
	if (!session || session.demo)
		return json({ error: 'Sign in to revoke invitations.' }, { status: 401 });
	if (!z.string().uuid().safeParse(params.inviteId).success)
		return json({ error: 'Invitation id is invalid.' }, { status: 400 });
	try {
		const workspace = await workspaceFromPostgres(session.tenantSlug, session.userId, session.role);
		if (!workspace) return json({ error: 'Active membership is unavailable.' }, { status: 403 });
		const ok = await revokeTenantInvite(workspace.tenant.id, session.userId, params.inviteId);
		return json({ ok });
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
