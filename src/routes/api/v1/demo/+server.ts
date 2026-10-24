import { json } from '@sveltejs/kit';
import { demoModeAvailable, listTenants } from '$lib/server/store';
import { makeSession, cookieName } from '../../../../hooks.server';

export async function POST({ request, cookies }) {
	if (!demoModeAvailable())
		return json({ error: 'Demo access is disabled in this environment.' }, { status: 404 });
	let body: { tenant?: string };
	try {
		body = await request.json();
	} catch {
		return json({ error: 'Send JSON with a tenant slug.' }, { status: 400 });
	}
	const tenant = body.tenant || 'riverstone';
	if (!['riverstone', 'harbor'].includes(tenant))
		return json({ error: 'Unknown demo tenant.' }, { status: 400 });
	const session = makeSession({
		userId: `demo:${tenant}`,
		tenantSlug: tenant,
		role: 'owner',
		demo: true
	});
	cookies.set(cookieName, session, {
		path: '/',
		httpOnly: true,
		sameSite: 'lax',
		secure: process.env.NODE_ENV === 'production',
		maxAge: 60 * 60 * 12
	});
	const tenants = await listTenants();
	return json({ ok: true, demo: true, tenant: tenants.find((item) => item.slug === tenant) });
}

export async function DELETE({ cookies }) {
	cookies.delete(cookieName, { path: '/' });
	return json({ ok: true });
}
