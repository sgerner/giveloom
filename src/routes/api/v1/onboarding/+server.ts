import { json } from '@sveltejs/kit';
import { getOnboardingChecklist } from '$lib/server/branding';
import { ServiceError } from '$lib/server/tenant-service';
export async function GET({ locals }) {
	if (!locals.session) return json({ error: 'Sign in to view workspace setup.' }, { status: 401 });
	try {
		return json(
			{ onboarding: await getOnboardingChecklist(locals.session) },
			{ headers: { 'cache-control': 'private, no-store' } }
		);
	} catch (error) {
		const status = error instanceof ServiceError ? error.status : 503;
		return json(
			{
				error:
					error instanceof Error && status < 500
						? error.message
						: 'Workspace setup is temporarily unavailable.'
			},
			{ status, headers: { 'cache-control': 'no-store' } }
		);
	}
}
