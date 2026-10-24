import { json } from '@sveltejs/kit';
import { createCampaignLink, CampaignError } from '$lib/server/campaigns';
import { getPool } from '$lib/server/database';
async function list(session: App.Locals['session'], id: string) {
	if (!session) throw new CampaignError('Sign in first.', 401);
	if (!['owner', 'admin', 'fundraising_manager', 'fundraiser'].includes(session.role))
		throw new CampaignError('Role cannot manage campaign links.', 403);
	const tenant = await getPool().query('SELECT id FROM tenants WHERE slug=$1', [
		session.tenantSlug
	]);
	if (!tenant.rowCount) throw new CampaignError('Workspace not found.', 404);
	const client = await getPool().connect();
	try {
		await client.query('BEGIN');
		await client.query("SELECT set_config('app.tenant_id',$1,true)", [tenant.rows[0].id]);
		const rows = await client.query(
			'SELECT id,code,label,variant_id AS "variantId",fundraiser_id AS "fundraiserId",clicks,created_at AS "createdAt" FROM campaign_links WHERE tenant_id=$1 AND campaign_id=$2 ORDER BY created_at DESC',
			[tenant.rows[0].id, id]
		);
		await client.query('COMMIT');
		return rows.rows;
	} catch (error) {
		await client.query('ROLLBACK');
		throw error;
	} finally {
		client.release();
	}
}
function fail(error: unknown) {
	return json(
		{ error: error instanceof Error ? error.message : 'Campaign link request failed.' },
		{ status: Number((error as { status?: number })?.status) || 400 }
	);
}
export async function GET({ params, locals }) {
	try {
		return json({ links: await list(locals.session, params.id) });
	} catch (error) {
		return fail(error);
	}
}
export async function POST({ params, request, locals }) {
	try {
		return json(await createCampaignLink(locals.session, params.id, await request.json()), {
			status: 201
		});
	} catch (error) {
		return fail(error);
	}
}
