import { json } from '@sveltejs/kit';
import { createVariant, CampaignError } from '$lib/server/campaigns';
import { getPool } from '$lib/server/database';
export async function GET({ params, locals }) {
	try {
		if (!locals.session) throw new CampaignError('Sign in first.', 401);
		if (!['owner', 'admin', 'fundraising_manager', 'fundraiser'].includes(locals.session.role))
			throw new CampaignError('Role cannot manage campaigns.', 403);
		const tenant = await getPool().query('SELECT id FROM tenants WHERE slug=$1', [
			locals.session.tenantSlug
		]);
		if (!tenant.rowCount) throw new CampaignError('Workspace not found.', 404);
		const client = await getPool().connect();
		try {
			await client.query('BEGIN');
			await client.query("SELECT set_config('app.tenant_id',$1,true)", [tenant.rows[0].id]);
			const rows = await client.query(
				'SELECT v.id,v.name,v.weight,v.content,v.active,v.impressions,v.conversions FROM campaign_variants v JOIN campaigns c ON c.tenant_id=v.tenant_id AND c.id=v.campaign_id WHERE v.tenant_id=$1 AND v.campaign_id=$2 ORDER BY v.created_at',
				[tenant.rows[0].id, params.id]
			);
			await client.query('COMMIT');
			return json({ variants: rows.rows });
		} catch (error) {
			await client.query('ROLLBACK');
			throw error;
		} finally {
			client.release();
		}
	} catch (error) {
		return json(
			{ error: error instanceof Error ? error.message : 'Variant listing failed.' },
			{ status: Number((error as { status?: number })?.status) || 400 }
		);
	}
}
export async function POST({ params, request, locals }) {
	try {
		return json(await createVariant(locals.session, params.id, await request.json()), {
			status: 201
		});
	} catch (error) {
		return json(
			{ error: error instanceof Error ? error.message : 'Variant could not be created.' },
			{ status: Number((error as { status?: number })?.status) || 422 }
		);
	}
}
