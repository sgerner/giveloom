import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { listProposals, saveProposal } from '$lib/server/stewardship';
import { AutomationError } from '$lib/server/automation';
export async function GET({ url, locals }) {
	try {
		return json(
			await listProposals(locals.session, url.searchParams.get('contactId') || undefined),
			{ headers: { 'cache-control': 'private, no-store' } }
		);
	} catch (error) {
		return json(
			{ error: error instanceof Error ? error.message : 'Proposals unavailable.' },
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
				stage: z
					.enum(['discovery', 'drafting', 'submitted', 'negotiation', 'won', 'lost'])
					.optional(),
				askMinor: z.number().int().min(0),
				currency: z.string().length(3).optional(),
				expectedCloseAt: z.string().date().nullable().optional(),
				notes: z.string().max(8000).optional(),
				ownerId: z.string().uuid().optional()
			})
			.strict()
			.parse(await request.json());
		if (body.tenant !== locals.session?.tenantSlug)
			throw new AutomationError('Tenant access denied.', locals.session ? 403 : 401);
		return json(await saveProposal(locals.session, body), { status: 201 });
	} catch (error) {
		return json(
			{ error: error instanceof Error ? error.message : 'Proposal update failed.' },
			{
				status:
					Number((error as { status?: number })?.status) ||
					((error as { name?: string })?.name === 'ZodError' ? 422 : 400)
			}
		);
	}
}
export async function PATCH({ request, locals }) {
	try {
		const body = z
			.object({
				id: z.string().uuid(),
				contactId: z.string().uuid(),
				title: z.string().min(1).max(180),
				stage: z.enum(['discovery', 'drafting', 'submitted', 'negotiation', 'won', 'lost']),
				askMinor: z.number().int().min(0),
				currency: z.string().length(3),
				expectedCloseAt: z.string().date().nullable(),
				notes: z.string().max(8000),
				ownerId: z.string().uuid().optional()
			})
			.strict()
			.parse(await request.json());
		return json(await saveProposal(locals.session, body));
	} catch (error) {
		return json(
			{ error: error instanceof Error ? error.message : 'Proposal update failed.' },
			{
				status:
					Number((error as { status?: number })?.status) ||
					((error as { name?: string })?.name === 'ZodError' ? 422 : 400)
			}
		);
	}
}
