import { json } from '@sveltejs/kit';
import { getTenantBranding, updateTenantBranding } from '$lib/server/branding';
import { ServiceError } from '$lib/server/tenant-service';

function fail(error: unknown) {
	const status =
		error instanceof ServiceError
			? error.status
			: (error as { name?: string })?.name === 'ZodError'
				? 422
				: 500;
	return json(
		{
			error:
				error instanceof Error && status !== 500
					? error.message
					: 'Brand settings could not be loaded or saved.'
		},
		{ status, headers: { 'cache-control': 'no-store' } }
	);
}
export async function GET({ locals }) {
	if (!locals.session)
		return json({ error: 'Sign in to manage workspace branding.' }, { status: 401 });
	if (locals.session.demo)
		return json({ error: 'Workspace branding requires persistent storage.' }, { status: 503 });
	try {
		return json(
			{ branding: await getTenantBranding(locals.session) },
			{ headers: { 'cache-control': 'private, no-store' } }
		);
	} catch (error) {
		return fail(error);
	}
}
export async function PUT({ locals, request }) {
	if (!locals.session)
		return json({ error: 'Sign in to manage workspace branding.' }, { status: 401 });
	if (locals.session.demo)
		return json({ error: 'Workspace branding requires persistent storage.' }, { status: 503 });
	try {
		return json(
			{ branding: await updateTenantBranding(locals.session, await request.json()) },
			{ headers: { 'cache-control': 'no-store' } }
		);
	} catch (error) {
		return fail(error);
	}
}
