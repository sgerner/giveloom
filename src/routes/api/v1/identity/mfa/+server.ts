import { json } from '@sveltejs/kit';
import { workspaceFromPostgres } from '$lib/server/database';
import { getMfaStatus } from '$lib/server/identity';
export async function GET({ locals }) {
	const session = locals.session;
	if (!session || session.demo)
		return json({ error: 'Sign in to view MFA status.' }, { status: 401 });
	try {
		const workspace = await workspaceFromPostgres(session.tenantSlug, session.userId, session.role);
		if (!workspace) return json({ error: 'Active membership is unavailable.' }, { status: 403 });
		return json(
			{ enabled: await getMfaStatus(workspace.tenant.id, session.userId) },
			{ headers: { 'cache-control': 'private, no-store' } }
		);
	} catch {
		return json({ error: 'Identity service is temporarily unavailable.' }, { status: 503 });
	}
}
