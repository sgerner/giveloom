import { json } from '@sveltejs/kit';
import { workspaceFromPostgres } from '$lib/server/database';
import { listStaffSessions } from '$lib/server/identity';
export async function GET({ locals }) {
	const session = locals.session;
	if (!session || session.demo || !session.sessionId)
		return json({ error: 'Sign in to view sessions.' }, { status: 401 });
	try {
		const workspace = await workspaceFromPostgres(session.tenantSlug, session.userId, session.role);
		if (!workspace) return json({ error: 'Active membership is unavailable.' }, { status: 403 });
		return json(
			{ sessions: await listStaffSessions(workspace.tenant.id, session.userId, session.sessionId) },
			{ headers: { 'cache-control': 'private, no-store' } }
		);
	} catch {
		return json({ error: 'Identity service is temporarily unavailable.' }, { status: 503 });
	}
}
