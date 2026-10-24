import { redirect } from '@sveltejs/kit';
export function load({ locals }) {
	if (!locals.session) redirect(303, '/login');
	redirect(303, '/app/' + encodeURIComponent(locals.session.tenantSlug) + '/settings/general');
}
