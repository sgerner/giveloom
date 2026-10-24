import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { readAuditPostgres } from '$lib/server/database';
import { readDemoAudit } from '$lib/server/store';

export async function GET({ url, locals }) {
	const session = locals.session;
	if (!session) return json({ error: 'Sign in before accessing audit history.' }, { status: 401 });
	const requested = url.searchParams.get('tenant');
	if (requested && requested !== session.tenantSlug)
		return json({ error: 'The requested tenant is not in your active session.' }, { status: 403 });
	try {
		const items = env.DATABASE_URL
			? await readAuditPostgres(session.tenantSlug, session.userId)
			: session.demo && session.role === 'owner'
				? await readDemoAudit(session.tenantSlug)
				: null;
		if (!items)
			return json({ error: 'Audit history requires an owner or admin role.' }, { status: 403 });
		return json({ items }, { headers: { 'cache-control': 'private, no-store' } });
	} catch (error) {
		return json(
			{
				error: error instanceof Error ? error.message : 'Audit history is temporarily unavailable.'
			},
			{ status: (error as { status?: number }).status || 503 }
		);
	}
}
