import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { env } from '$env/dynamic/private';
import { authorizedWorkspace } from '$lib/server/context';
import { tenantTransaction } from '$lib/server/tenant-service';
import { mutatePostgres } from '$lib/server/database';
import { applyMutation } from '$lib/server/store';
import { validateIntroductionTransition, introductionStages } from '$lib/server/intelligence';

const schema = z
	.object({
		tenant: z.string().min(1),
		id: z.string().uuid(),
		stage: z.enum(introductionStages),
		note: z.string().max(2000).default(''),
		ownerId: z.string().uuid().optional(),
		dueAt: z.string().datetime().optional(),
		outcome: z.string().max(2000).optional()
	})
	.strict();
const allowedRoles = ['owner', 'admin', 'fundraising_manager', 'fundraiser'] as const;
function errorResponse(error: unknown) {
	return json(
		{ error: error instanceof Error ? error.message : 'Introduction transition failed.' },
		{ status: Number((error as any)?.status) || ((error as any)?.name === 'ZodError' ? 422 : 422) }
	);
}

export async function POST({ request, locals }) {
	try {
		const body = schema.parse(await request.json());
		if (!locals.session) throw Object.assign(new Error('Sign in first.'), { status: 401 });
		if (body.tenant !== locals.session.tenantSlug)
			throw Object.assign(new Error('Tenant access denied.'), { status: 403 });
		let current: any, transition: any;
		if (env.DATABASE_URL) {
			await tenantTransaction(locals.session, allowedRoles, async (client, tenant) => {
				const row = await client.query(
					"SELECT data FROM workspace_records WHERE tenant_id=$1 AND resource='introductions' AND id=$2 AND archived_at IS NULL",
					[tenant.id, body.id]
				);
				if (!row.rowCount)
					throw Object.assign(new Error('Introduction not found.'), { status: 404 });
				current = { ...row.rows[0].data, id: body.id };
				transition = validateIntroductionTransition(
					String(current.stage || 'proposed'),
					body.stage
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
		} else {
			const workspace = await authorizedWorkspace(locals.session, body.tenant, true);
			current = workspace.introductions.find((item: any) => item.id === body.id);
			if (!current) return json({ error: 'Introduction not found.' }, { status: 404 });
			transition = validateIntroductionTransition(String(current.stage || 'proposed'), body.stage);
		}
		const updated = {
			...current,
			stage: body.stage,
			...(body.ownerId ? { ownerId: body.ownerId } : {}),
			...(body.dueAt ? { dueAt: body.dueAt } : {}),
			...(body.outcome !== undefined ? { outcome: body.outcome } : {})
		};
		if (env.DATABASE_URL) {
			await mutatePostgres(body.tenant, locals.session.userId, 'introductions', updated, 'update');
			await tenantTransaction(locals.session, allowedRoles, async (client, tenant) => {
				await client.query(
					'INSERT INTO introduction_events(tenant_id,introduction_id,from_stage,to_stage,actor_id,note,owner_id,due_at,outcome) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
					[
						tenant.id,
						body.id,
						transition.from,
						transition.to,
						locals.session!.userId,
						body.note,
						body.ownerId || current.ownerId || null,
						body.dueAt || current.dueAt || null,
						body.outcome || ''
					]
				);
			});
		} else
			await applyMutation(body.tenant, 'introductions', updated, 'update', locals.session.role);
		return json({ ok: true, transition }, { headers: { 'cache-control': 'private, no-store' } });
	} catch (error) {
		return errorResponse(error);
	}
}
