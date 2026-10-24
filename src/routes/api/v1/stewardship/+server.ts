import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { listStewardship, saveStewardshipPlan } from '$lib/server/stewardship';
import { AutomationError } from '$lib/server/automation';
export async function GET({ url, locals }) {
	try {
		return json(
			await listStewardship(locals.session, url.searchParams.get('contactId') || undefined),
			{ headers: { 'cache-control': 'private, no-store' } }
		);
	} catch (error) {
		return json(
			{ error: error instanceof Error ? error.message : 'Stewardship data unavailable.' },
			{ status: Number((error as { status?: number })?.status) || 400 }
		);
	}
}
export async function POST({ request, locals }) {
	try {
		const body = z
			.object({
				tenant: z.string().min(1).max(80),
				contactId: z.string().uuid(),
				title: z.string().min(1).max(180),
				goal: z.string().max(4000).optional(),
				ownerId: z.string().uuid().optional(),
				status: z.enum(['active', 'completed', 'cancelled']).optional(),
				reviewAt: z.string().datetime().nullable().optional(),
				steps: z
					.array(
						z.object({
							kind: z.enum([
								'call',
								'meeting',
								'email_draft',
								'proposal',
								'research',
								'note',
								'other'
							]),
							title: z.string().min(1).max(180),
							dueAt: z.string().datetime().nullable().optional(),
							status: z.enum(['open', 'completed', 'skipped']).optional(),
							outcome: z.string().max(4000).optional()
						})
					)
					.max(100)
					.optional(),
				id: z.string().uuid().optional()
			})
			.strict()
			.parse(await request.json());
		if (body.tenant !== locals.session?.tenantSlug)
			throw new AutomationError('Tenant access denied.', locals.session ? 403 : 401);
		return json(await saveStewardshipPlan(locals.session, body), { status: body.id ? 200 : 201 });
	} catch (error) {
		return json(
			{ error: error instanceof Error ? error.message : 'Stewardship update failed.' },
			{
				status:
					Number((error as { status?: number })?.status) ||
					((error as { name?: string })?.name === 'ZodError' ? 422 : 400)
			}
		);
	}
}
