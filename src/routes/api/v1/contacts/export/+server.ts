import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { contactsToCsv } from '$lib/server/csv';
import { getWorkspace, recordDemoRead } from '$lib/server/store';
import { auditPostgresRead, canExportContacts, workspaceFromPostgres } from '$lib/server/database';

export async function GET({ url, locals }) {
	const session = locals.session;
	if (!session) return json({ error: 'Sign in before exporting contacts.' }, { status: 401 });
	if (!canExportContacts(session.role))
		return json({ error: 'Your role cannot export contacts.' }, { status: 403 });
	const tenant = url.searchParams.get('tenant');
	if (tenant && tenant !== session.tenantSlug)
		return json({ error: 'The requested tenant is not in your active session.' }, { status: 403 });
	try {
		let workspace;
		if (env.DATABASE_URL) {
			await auditPostgresRead(session.tenantSlug, session.userId, 'contacts.export', 'contacts');
			workspace = await workspaceFromPostgres(session.tenantSlug, session.userId, session.role);
		} else {
			if (
				!session.demo ||
				!['owner', 'admin', 'fundraising_manager', 'fundraiser'].includes(session.role)
			)
				return json({ error: 'Your role cannot export contacts.' }, { status: 403 });
			workspace = await getWorkspace(session.tenantSlug);
			if (workspace) await recordDemoRead(session.tenantSlug, 'contacts.export');
		}
		if (!workspace) return json({ error: 'Tenant not found.' }, { status: 404 });
		const safeSlug = session.tenantSlug.replace(/[^a-zA-Z0-9_-]/g, '_');
		return new Response(contactsToCsv(workspace.contacts), {
			headers: {
				'content-type': 'text/csv; charset=utf-8',
				'content-disposition': `attachment; filename="${safeSlug}-contacts.csv"`,
				'cache-control': 'private, no-store',
				'x-content-type-options': 'nosniff'
			}
		});
	} catch (error) {
		const status = Number((error as { status?: number })?.status) || 400;
		return json(
			{ error: error instanceof Error ? error.message : 'Export could not be completed.' },
			{ status }
		);
	}
}
