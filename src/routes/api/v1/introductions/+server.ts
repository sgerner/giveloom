import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { env } from '$env/dynamic/private';
import { authorizedWorkspace } from '$lib/server/context';
import { tenantTransaction } from '$lib/server/tenant-service';
import { applyMutation } from '$lib/server/store';
import { mutatePostgres } from '$lib/server/database';

const schema = z
	.object({
		tenant: z.string(),
		contactId: z.string().uuid(),
		prospectId: z.string().uuid(),
		title: z.string().trim().min(3).max(240),
		notes: z.string().max(2000).default(''),
		ownerId: z.string().uuid().optional(),
		dueAt: z.string().datetime().optional()
	})
	.strict();
const allowedRoles = ['owner', 'admin', 'fundraising_manager', 'fundraiser'] as const;
function errorResponse(error: unknown) {
	return json(
		{
			error: error instanceof Error ? error.message : 'Introduction request could not be created.'
		},
		{ status: Number((error as any)?.status) || ((error as any)?.name === 'ZodError' ? 422 : 422) }
	);
}

export async function POST({ request, locals }) {
	try {
		const body = schema.parse(await request.json());
		if (!locals.session) throw Object.assign(new Error('Sign in first.'), { status: 401 });
		if (body.tenant !== locals.session.tenantSlug)
			throw Object.assign(new Error('Tenant access denied.'), { status: 403 });
		const data = {
			contactId: body.contactId,
			prospectId: body.prospectId,
			title: body.title,
			notes: body.notes,
			stage: 'proposed',
			ownerId: body.ownerId || null,
			dueAt: body.dueAt || null,
			outcome: ''
		};
		let result: any;
		if (env.DATABASE_URL) {
			await tenantTransaction(locals.session, allowedRoles, async (client, tenant) => {
				const [contact, prospect] = await Promise.all([
					client.query(
						'SELECT 1 FROM contacts WHERE tenant_id=$1 AND id=$2 AND archived_at IS NULL AND merged_into IS NULL',
						[tenant.id, body.contactId]
					),
					client.query('SELECT 1 FROM prospects WHERE tenant_id=$1 AND id=$2', [
						tenant.id,
						body.prospectId
					])
				]);
				if (!contact.rowCount || !prospect.rowCount)
					throw Object.assign(
						new Error('Select an active supporter and a prospect from this tenant.'),
						{ status: 404 }
					);
				if (body.ownerId) {
					const owner = await client.query(
						"SELECT 1 FROM memberships WHERE tenant_id=$1 AND user_id=$2 AND status='active'",
						[tenant.id, body.ownerId]
					);
					if (!owner.rowCount)
						throw Object.assign(new Error('The selected owner is not an active tenant member.'), {
							status: 422
						});
				}
			});
			result = await mutatePostgres(
				body.tenant,
				locals.session.userId,
				'introductions',
				data,
				'create'
			);
			await tenantTransaction(locals.session, allowedRoles, async (client, tenant) => {
				await client.query(
					"INSERT INTO introduction_events(tenant_id,introduction_id,from_stage,to_stage,actor_id,note,owner_id,due_at,outcome) VALUES($1,$2,'','proposed',$3,$4,$5,$6,$7)",
					[
						tenant.id,
						result.id,
						locals.session!.userId,
						body.notes,
						body.ownerId || null,
						body.dueAt || null,
						''
					]
				);
			});
		} else {
			const workspace = await authorizedWorkspace(locals.session, body.tenant, true);
			if (
				!workspace.contacts.some((item: any) => item.id === body.contactId) ||
				!workspace.prospects.some((item: any) => item.id === body.prospectId)
			)
				return json(
					{ error: 'Select a supporter and a prospect from this tenant.' },
					{ status: 404 }
				);
			result = (
				await applyMutation(body.tenant, 'introductions', data, 'create', locals.session.role)
			).item;
		}
		return json(
			{ ok: true, introduction: result },
			{ status: 201, headers: { 'cache-control': 'private, no-store' } }
		);
	} catch (error) {
		return errorResponse(error);
	}
}
