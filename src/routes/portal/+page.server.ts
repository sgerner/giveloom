import { env } from '$env/dynamic/private';
import { getPortalOverview } from '$lib/server/portal';
import { getPublicTenantBranding } from '$lib/server/branding';

export async function load({ cookies, url, setHeaders }) {
	setHeaders({ 'cache-control': 'private, no-store' });
	if (!env.DATABASE_URL)
		return { portal: null, available: false, tenant: url.searchParams.get('tenant') || '' };
	try {
		const portal = await getPortalOverview(cookies.get('giveloom_portal'));
		const tenant = portal?.tenantSlug || url.searchParams.get('tenant') || '';
		return {
			portal,
			branding: tenant ? await getPublicTenantBranding(tenant) : null,
			available: true,
			tenant
		};
	} catch {
		return { portal: null, available: true, tenant: url.searchParams.get('tenant') || '' };
	}
}
