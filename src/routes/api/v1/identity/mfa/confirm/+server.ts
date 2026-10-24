import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { workspaceFromPostgres } from '$lib/server/database';
import { confirmMfaEnrollment } from '$lib/server/identity';
export async function POST({ request, locals }) {
	const session = locals.session;
	if (!session || session.demo) return json({ error: 'Sign in to enable MFA.' }, { status: 401 });
	try {
		const { code } = z
			.object({ code: z.string().regex(/^\d{6}$/) })
			.strict()
			.parse(await request.json());
		const workspace = await workspaceFromPostgres(session.tenantSlug, session.userId, session.role);
		if (!workspace) return json({ error: 'Active membership is unavailable.' }, { status: 403 });
		const recoveryCodes = await confirmMfaEnrollment(workspace.tenant.id, session.userId, code);
		return recoveryCodes
			? json({ ok: true, recoveryCodes }, { headers: { 'cache-control': 'no-store' } })
			: json({ error: 'The authenticator code is invalid.' }, { status: 400 });
	} catch (error) {
		if (error instanceof z.ZodError)
			return json({ error: 'Enter the six-digit authenticator code.' }, { status: 400 });
		return json({ error: 'MFA could not be enabled.' }, { status: 503 });
	}
}
