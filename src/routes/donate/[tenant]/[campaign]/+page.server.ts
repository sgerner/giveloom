import { error } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { getWorkspace, demoModeAvailable } from '$lib/server/store';
import { getPool } from '$lib/server/database';
import { publicCampaign } from '$lib/server/campaigns';
import { getPublicTenantBranding } from '$lib/server/branding';
const defaultForm = {
	frequencies: ['once'],
	suggestedAmounts: [2500, 5000, 10000, 25000],
	allowCustomAmount: true,
	askForAddress: false,
	allowAnonymous: true,
	allowTribute: true,
	allowFeeCoverage: false,
	feeCoverageBasisPoints: 0,
	feeCoverageFixedMinor: 0,
	allowDesignation: false,
	designationFundIds: [],
	terms: 'I authorize this gift to the organization.'
};
export async function load({ params, url }) {
	if (!env.DATABASE_URL) {
		if (!demoModeAvailable()) error(404, 'Campaign not found');
		const workspace = await getWorkspace(params.tenant);
		const campaign = workspace?.campaigns.find((c) => c.id === params.campaign);
		if (!workspace || !campaign) error(404, 'Campaign not found');
		return {
			organization: workspace.tenant.name,
			branding: { publicName: workspace.tenant.name, logoUrl: null, theme: 'donor-crm' },
			campaign: {
				id: String(campaign.id),
				name: String(campaign.name),
				description: String(
					campaign.description ||
						'Help our neighbors thrive. Together, a little generosity goes a long way.'
				),
				goalMinor: Number(campaign.goalMinor),
				story: String(campaign.story || campaign.description || ''),
				formConfig: campaign.formConfig || defaultForm,
				variant: null as { id: string; headline?: string; description?: string } | null
			},
			currency: workspace.tenant.currency,
			canAcceptPayments: false,
			demo: true,
			fundraiserId: url.searchParams.get('fundraiser') || '',
			campaignLinkCode: url.searchParams.get('ref') || ''
		};
	}
	const pool = getPool();
	const tenant = await pool.query(
		'SELECT id,legal_name,currency FROM tenants WHERE slug=$1 AND suspended_at IS NULL',
		[params.tenant]
	);
	if (!tenant.rowCount) error(404, 'Campaign not found');
	const tenantBranding = await getPublicTenantBranding(params.tenant);
	const client = await pool.connect();
	try {
		await client.query('BEGIN');
		await client.query("SELECT set_config('app.tenant_id',$1,true)", [tenant.rows[0].id]);
		const result = await client.query(
			"SELECT id,name,goal_minor,data,public_slug,story,form_config,status,fund_id,hero_file_id,starts_at,ends_at FROM campaigns WHERE tenant_id=$1 AND (id::text=$2 OR (status IN ('published','scheduled') AND public_slug=$2)) AND status IN ('active','published','scheduled') AND (starts_at IS NULL OR starts_at<=now()) AND (ends_at IS NULL OR ends_at>now())",
			[tenant.rows[0].id, params.campaign]
		);
		if (!result.rowCount) {
			await client.query('ROLLBACK');
			error(404, 'Campaign is not published');
		}
		const account = await client.query('SELECT enabled FROM stripe_accounts WHERE tenant_id=$1', [
			tenant.rows[0].id
		]);
		const row = result.rows[0];
		const formConfig = { ...defaultForm, ...(row.form_config || {}) };
		const configuredFunds = Array.isArray(formConfig.designationFundIds)
			? formConfig.designationFundIds
			: [];
		const designationFundIds = formConfig.allowDesignation
			? [...new Set([...configuredFunds, ...(row.fund_id ? [String(row.fund_id)] : [])])]
			: [];
		const designations = designationFundIds.length
			? await client.query(
					'SELECT id,name FROM funds WHERE tenant_id=$1 AND active=true AND id=ANY($2::uuid[]) ORDER BY name',
					[tenant.rows[0].id, designationFundIds]
				)
			: { rows: [] };
		const publicData =
			row.public_slug && ['published', 'scheduled'].includes(row.status)
				? await publicCampaign(
						params.tenant,
						String(row.public_slug),
						url.searchParams.get('ref') || undefined
					)
				: null;
		await client.query('COMMIT');
		return {
			organization: String(tenantBranding?.publicName || tenant.rows[0].legal_name),
			branding: tenantBranding,
			campaign: {
				id: String(row.id),
				name: String(row.name),
				description: String(row.data?.description || ''),
				goalMinor: Number(row.goal_minor),
				story: String(row.story || row.data?.description || ''),
				formConfig,
				heroImageUrl:
					publicData?.campaign?.heroImageUrl ||
					(row.hero_file_id
						? `/campaign-image/${encodeURIComponent(params.tenant)}/${encodeURIComponent(String(row.id))}`
						: null),
				variant: publicData?.variant || null
			},
			currency: String(tenant.rows[0].currency),
			canAcceptPayments: Boolean(
				row.data?.acceptsOnlineGifts !== false &&
				account.rows[0]?.enabled &&
				env.STRIPE_PLATFORM_SECRET_KEY &&
				env.STRIPE_CONNECT_PUBLISHABLE_KEY
			),
			demo: false,
			fundraiserId: url.searchParams.get('fundraiser') || '',
			campaignLinkCode: url.searchParams.get('ref') || '',
			designations: designations.rows
		};
	} catch (e) {
		await client.query('ROLLBACK');
		throw e;
	} finally {
		client.release();
	}
}
