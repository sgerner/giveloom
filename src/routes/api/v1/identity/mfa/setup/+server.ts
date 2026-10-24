import { json } from '@sveltejs/kit';
import { workspaceFromPostgres } from '$lib/server/database';
import { startMfaEnrollment } from '$lib/server/identity';
export async function POST({ locals }) {
	const session = locals.session;
	if (!session || session.demo) return json({ error: 'Sign in to set up MFA.' }, { status: 401 });
	try {
		const workspace = await workspaceFromPostgres(session.tenantSlug, session.userId, session.role);
		if (!workspace) return json({ error: 'Active membership is unavailable.' }, { status: 403 });
		return json(
			await startMfaEnrollment(workspace.tenant.id, session.userId, workspace.user.email),
			{ headers: { 'cache-control': 'no-store' } }
		);
	} catch {
		return json({ error: 'MFA setup is unavailable.' }, { status: 503 });
	}
}
