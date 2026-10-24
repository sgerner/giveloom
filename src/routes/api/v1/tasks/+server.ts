import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { createTask, listTasks } from '$lib/server/stewardship';
import { AutomationError } from '$lib/server/automation';
const fail = (error: unknown) =>
	json(
		{ error: error instanceof Error ? error.message : 'Task request failed.' },
		{
			status:
				Number((error as { status?: number })?.status) ||
				((error as { name?: string })?.name === 'ZodError' ? 422 : 400)
		}
	);
export async function GET({ url, locals }) {
	try {
		return json(
			await listTasks(locals.session, {
				contactId: url.searchParams.get('contactId') || undefined,
				from: url.searchParams.get('from') || undefined,
				to: url.searchParams.get('to') || undefined
			}),
			{ headers: { 'cache-control': 'private, no-store' } }
		);
	} catch (error) {
		return fail(error);
	}
}
export async function POST({ request, locals }) {
	try {
		const body = z
			.object({
				tenant: z.string().min(1).max(80),
				title: z.string().min(1).max(180),
				contactId: z.string().uuid().nullable().optional(),
				dueAt: z.string().datetime().nullable().optional(),
				priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
				assignedTo: z.string().uuid().optional(),
				recurrence: z.record(z.string(), z.unknown()).optional()
			})
			.strict()
			.parse(await request.json());
		if (body.tenant !== locals.session?.tenantSlug)
			throw new AutomationError('Tenant access denied.', locals.session ? 403 : 401);
		return json(await createTask(locals.session, body), { status: 201 });
	} catch (error) {
		return fail(error);
	}
}
