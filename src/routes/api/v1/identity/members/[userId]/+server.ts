import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { workspaceFromPostgres } from '$lib/server/database';
import { changeMemberRole } from '$lib/server/identity';
export async function PATCH({ request, params, locals }) {
	const session = locals.session;
	if (!session || session.demo)
		return json({ error: 'Sign in to manage workspace roles.' }, { status: 401 });
	try {
		const { role } = z
			.object({ role: z.string().min(1).max(40) })
			.strict()
			.parse(await request.json());
		const workspace = await workspaceFromPostgres(session.tenantSlug, session.userId, session.role);
		if (!workspace) return json({ error: 'Active membership is unavailable.' }, { status: 403 });
		await changeMemberRole(workspace.tenant.id, session.userId, params.userId, role);
		return json({ ok: true });
	} catch (error) {
		if (error instanceof z.ZodError)
			return json({ error: 'Choose a valid role.' }, { status: 400 });
		const status =
			error instanceof Error && 'status' in error
				? Number((error as { status: number }).status)
				: 503;
		return json(
			{
				error:
					status < 500
						? String((error as Error).message)
						: 'Identity service is temporarily unavailable.'
			},
			{ status }
		);
	}
}
