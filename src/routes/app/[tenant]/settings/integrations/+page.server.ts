import { error, redirect } from '@sveltejs/kit';
import { workspaceFromPostgres } from '$lib/server/database';
export async function load({ locals, params }) {
	const session = locals.session;
	if (!session) throw redirect(303, '/');
	if (session.demo) throw error(503, 'Integration controls require a persistent workspace.');
	if (session.tenantSlug !== params.tenant)
		throw error(403, 'Workspace does not match the active session.');
	const workspace = await workspaceFromPostgres(session.tenantSlug, session.userId, session.role);
	if (!workspace || !['owner', 'admin'].includes(workspace.user.role))
		throw error(403, 'Only workspace owners and administrators can open integration controls.');
	return { tenant: params.tenant };
}
