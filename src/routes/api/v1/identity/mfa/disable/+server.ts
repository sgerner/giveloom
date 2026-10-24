import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { workspaceFromPostgres } from '$lib/server/database';
import { disableMfa } from '$lib/server/identity';
export async function POST({ request, locals }) {
	const session = locals.session;
	if (!session || session.demo) return json({ error: 'Sign in to disable MFA.' }, { status: 401 });
	try {
		const { code } = z
			.object({ code: z.string().min(6).max(32) })
			.strict()
			.parse(await request.json());
		const workspace = await workspaceFromPostgres(session.tenantSlug, session.userId, session.role);
		if (!workspace) return json({ error: 'Active membership is unavailable.' }, { status: 403 });
		const ok = await disableMfa(workspace.tenant.id, session.userId, code);
		return ok
			? json({ ok: true })
			: json({ error: 'Authenticator or recovery code was not accepted.' }, { status: 400 });
	} catch (error) {
		if (error instanceof z.ZodError)
			return json({ error: 'Enter an authenticator or recovery code.' }, { status: 400 });
		return json({ error: 'MFA could not be disabled.' }, { status: 503 });
	}
}
