import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { createAutomation, listAutomations, AutomationError } from '$lib/server/automation';
const demoUnavailable = () =>
	json(
		{ error: 'Workflow management requires persistent storage and is unavailable in demo mode.' },
		{ status: 503, headers: { 'cache-control': 'private, no-store' } }
	);
const fail = (error: unknown) =>
	json(
		{ error: error instanceof Error ? error.message : 'Workflow request failed.' },
		{
			status:
				Number((error as { status?: number })?.status) ||
				((error as { name?: string })?.name === 'ZodError' ? 422 : 400)
		}
	);
export async function GET({ locals }) {
	if (locals.session?.demo) return demoUnavailable();
	try {
		return json(await listAutomations(locals.session), {
			headers: { 'cache-control': 'private, no-store' }
		});
	} catch (error) {
		return fail(error);
	}
}
export async function POST({ request, locals }) {
	if (locals.session?.demo) return demoUnavailable();
	try {
		const body = z
			.object({
				tenant: z.string().min(1).max(80),
				name: z.string().min(1).max(180),
				definition: z.unknown()
			})
			.strict()
			.parse(await request.json());
		if (body.tenant !== locals.session?.tenantSlug)
			throw new AutomationError('Tenant access denied.', locals.session ? 403 : 401);
		return json(await createAutomation(locals.session, body), {
			status: 201,
			headers: { 'cache-control': 'private, no-store' }
		});
	} catch (error) {
		return fail(error);
	}
}
