import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { workspaceFromPostgres } from '$lib/server/database';
import { createTenantInvite, listTenantInvites } from '$lib/server/identity';
import { operatorTransactionalEmailConfigured } from '$lib/server/communications';
const schema = z
	.object({
		email: z.string().trim().email().max(254),
		name: z.string().trim().min(1).max(120),
		role: z.string().min(1).max(40)
	})
	.strict();
export async function GET({ locals }) {
	const session = locals.session;
	if (!session || session.demo)
		return json({ error: 'Sign in to manage workspace access.' }, { status: 401 });
	try {
		const workspace = await workspaceFromPostgres(session.tenantSlug, session.userId, session.role);
		if (!workspace) return json({ error: 'Active membership is unavailable.' }, { status: 403 });
		return json(
			{ invites: await listTenantInvites(workspace.tenant.id, session.userId) },
			{ headers: { 'cache-control': 'private, no-store' } }
		);
	} catch (error) {
		return json(
			{
				error:
					error instanceof Error && 'status' in error
						? error.message
						: 'Identity service is temporarily unavailable.'
			},
			{
				status:
					error instanceof Error && 'status' in error
						? Number((error as { status: number }).status)
						: 503
			}
		);
	}
}
export async function POST({ request, locals }) {
	const session = locals.session;
	if (!session || session.demo)
		return json({ error: 'Sign in to manage workspace access.' }, { status: 401 });
	if (!operatorTransactionalEmailConfigured())
		return json({ error: 'Transactional email is not configured.' }, { status: 503 });
	try {
		const input = schema.parse(await request.json());
		const workspace = await workspaceFromPostgres(session.tenantSlug, session.userId, session.role);
		if (!workspace) return json({ error: 'Active membership is unavailable.' }, { status: 403 });
		const invite = await createTenantInvite({
			tenantId: workspace.tenant.id,
			actorId: session.userId,
			...input
		});
		return json({ ok: true, invite }, { status: 202, headers: { 'cache-control': 'no-store' } });
	} catch (error) {
		if (error instanceof z.ZodError)
			return json({ error: 'Enter a valid email, name, and role.' }, { status: 400 });
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
