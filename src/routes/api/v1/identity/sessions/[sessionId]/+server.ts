import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { workspaceFromPostgres } from '$lib/server/database';
import { revokeStaffSession } from '$lib/server/identity';
export async function DELETE({ params, locals, cookies }) {
	const session = locals.session;
	if (!session || session.demo)
		return json({ error: 'Sign in to revoke sessions.' }, { status: 401 });
	if (!z.string().uuid().safeParse(params.sessionId).success)
		return json({ error: 'Session id is invalid.' }, { status: 400 });
	try {
		const workspace = await workspaceFromPostgres(session.tenantSlug, session.userId, session.role);
		if (!workspace) return json({ error: 'Active membership is unavailable.' }, { status: 403 });
		await revokeStaffSession(workspace.tenant.id, session.userId, params.sessionId);
		if (params.sessionId === session.sessionId) cookies.delete('giveloom_session', { path: '/' });
		return json({ ok: true });
	} catch {
		return json({ error: 'Identity service is temporarily unavailable.' }, { status: 503 });
	}
}
