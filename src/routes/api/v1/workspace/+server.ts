import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { mutationSchema, redactWorkspaceRecord, validateResource } from '$lib/server/domain';
import { applyMutation, getWorkspace, recordDemoRead } from '$lib/server/store';
import { mutatePostgres, workspaceFromPostgres } from '$lib/server/database';

function requireTenant(session: App.Locals['session'], requested: string | null) {
	if (!session)
		throw Object.assign(new Error('Sign in before accessing workspace data.'), { status: 401 });
	if (requested && requested !== session.tenantSlug)
		throw Object.assign(new Error('The requested tenant is not in your active session.'), {
			status: 403
		});
	return session.tenantSlug;
}
function responseError(error: unknown) {
	const code = String((error as { code?: unknown })?.code || '');
	if (code === '23505')
		return json({ error: 'A record with the same unique value already exists.' }, { status: 409 });
	if (code === '23503')
		return json(
			{ error: 'A referenced record is missing or belongs to another tenant.' },
			{ status: 422 }
		);
	if (code === '42501')
		return json({ error: 'You are not permitted to change this record.' }, { status: 403 });
	if (/^08/.test(code) || /^57/.test(code))
		return json({ error: 'The database is temporarily unavailable.' }, { status: 503 });
	if (code) return json({ error: 'The request could not be completed.' }, { status: 500 });
	const status =
		Number((error as { status?: number })?.status) || (error instanceof SyntaxError ? 400 : 400);
	return json(
		{ error: error instanceof Error ? error.message : 'Request could not be completed.' },
		{ status }
	);
}

export async function GET({ url, locals }) {
	try {
		const slug = requireTenant(locals.session, url.searchParams.get('tenant'));
		const compact = ['true', 'overview'].includes(url.searchParams.get('compact') || '');
		const contactLimit = Number(url.searchParams.get('contactLimit')) || 200;
		const workspace = env.DATABASE_URL
			? await workspaceFromPostgres(slug, locals.session!.userId, locals.session!.role, {
					compact,
					contactLimit
				})
			: locals.session!.demo
				? await getWorkspace(slug)
				: null;
		if (!workspace) return json({ error: 'Tenant not found.' }, { status: 404 });
		if (!env.DATABASE_URL) await recordDemoRead(slug, 'workspace');
		return json(workspace, { headers: { 'cache-control': 'private, no-store' } });
	} catch (error) {
		return responseError(error);
	}
}

export async function POST({ request, locals, url }) {
	try {
		const session = locals.session;
		const body = mutationSchema.parse(await request.json());
		const slug = requireTenant(session, body.tenant);
		const data = validateResource(body.resource, body.data) as Record<string, unknown>;
		const action = body.action || 'create';
		let item: Record<string, unknown>;
		let workspace;
		if (env.DATABASE_URL) {
			item = await mutatePostgres(slug, session!.userId, body.resource, data, action);
			const compact = ['true', 'overview'].includes(url.searchParams.get('compact') || '');
			workspace = compact
				? await workspaceFromPostgres(slug, session!.userId, session!.role, { compact: true })
				: await workspaceFromPostgres(slug, session!.userId, session!.role);
		} else {
			if (!session!.demo)
				throw Object.assign(new Error('A persistent production database is required.'), {
					status: 503
				});
			const result = await applyMutation(slug, body.resource, data, action, session!.role);
			item = result.item;
			workspace = result.workspace;
		}
		return json(
			{
				ok: true,
				resource: body.resource,
				item: redactWorkspaceRecord(session!.role, body.resource, item),
				workspace
			},
			{ status: action === 'create' ? 201 : 200, headers: { 'cache-control': 'private, no-store' } }
		);
	} catch (error) {
		if ((error as { name?: string })?.name === 'ZodError')
			return json(
				{ error: 'Request validation failed.', details: (error as { issues?: unknown }).issues },
				{ status: 422 }
			);
		return responseError(error);
	}
}
