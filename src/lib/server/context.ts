import { env } from '$env/dynamic/private';
import { workspaceFromPostgres } from './database';
import { getWorkspace } from './store';
export async function authorizedWorkspace(
	session: App.Locals['session'],
	tenant?: string,
	write = false
) {
	if (!session) throw Object.assign(new Error('Sign in first.'), { status: 401 });
	if (tenant && tenant !== session.tenantSlug)
		throw Object.assign(new Error('Tenant access denied.'), { status: 403 });
	const workspace = env.DATABASE_URL
		? await workspaceFromPostgres(session.tenantSlug, session.userId, session.role)
		: session.demo
			? await getWorkspace(session.tenantSlug)
			: null;
	if (!workspace) throw Object.assign(new Error('Workspace unavailable.'), { status: 404 });
	const role = workspace.user?.role || session.role;
	if (write && !['owner', 'admin', 'fundraising_manager', 'fundraiser'].includes(role))
		throw Object.assign(new Error('Your role cannot perform this action.'), { status: 403 });
	return workspace;
}
