import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { authorizedWorkspace } from '$lib/server/context';
import { getPool } from '$lib/server/database';

const csv = (value: unknown) => {
	let text = String(value ?? '')
		.replace(/[\r\n]+/g, ' ')
		.trim();
	if (/^[=+\-@\t]/.test(text)) text = `'${text}`;
	return `"${text.replaceAll('"', '""')}"`;
};
export async function GET({ url, locals }) {
	let client: any;
	try {
		await authorizedWorkspace(locals.session, url.searchParams.get('tenant') || undefined, true);
		if (!env.DATABASE_URL)
			return json(
				{ error: 'Licensed prospect export requires persistent storage.' },
				{ status: 503 }
			);
		const pool = getPool();
		const tenant = await pool.query('SELECT id FROM tenants WHERE slug=$1', [
			locals.session!.tenantSlug
		]);
		if (!tenant.rowCount) return json({ error: 'Tenant not found.' }, { status: 404 });
		client = await pool.connect();
		await client.query('BEGIN');
		await client.query("SELECT set_config('app.tenant_id',$1,true)", [tenant.rows[0].id]);
		const result = await client.query(
			`SELECT p.id,p.name,p.stage,p.match_status AS "matchStatus",p.data,
  string_agg(DISTINCT e.source_name,'; ') AS "sourceNames",string_agg(DISTINCT e.source_url,'; ') AS "sourceUrls",
  string_agg(DISTINCT e.observed_at::text,'; ') AS "observedAt",bool_and(s.enabled AND s.export_allowed AND 'export'=ANY(s.permitted_uses)) AS allowed
  FROM prospects p JOIN prospect_evidence e ON e.tenant_id=p.tenant_id AND e.prospect_id=p.id AND NOT (e.data ? 'detachedAfterSplitAt')
  JOIN research_sources s ON s.tenant_id=e.tenant_id AND s.id=e.source_id
  LEFT JOIN prospect_research_controls c ON c.tenant_id=p.tenant_id AND c.prospect_id=p.id
  WHERE p.tenant_id=$1 AND COALESCE(p.data->>'mergedInto','')='' AND COALESCE(c.excluded,false)=false AND COALESCE(c.opted_out,false)=false
  GROUP BY p.id,p.name,p.stage,p.match_status,p.data ORDER BY p.name`,
			[tenant.rows[0].id]
		);
		const rows = result.rows.filter((row: any) => row.allowed);
		const headings = [
			'Name',
			'Stage',
			'Match status',
			'Reason',
			'Filing year',
			'Sources',
			'Source URLs',
			'Observed dates'
		];
		const lines = [
			headings.map(csv).join(','),
			...rows.map((row: any) =>
				[
					row.name,
					row.stage,
					row.matchStatus,
					row.data?.reason,
					row.data?.filingYear,
					row.sourceNames,
					row.sourceUrls,
					row.observedAt
				]
					.map(csv)
					.join(',')
			)
		];
		await client.query(
			'INSERT INTO audit_log(tenant_id,actor_id,action,resource,details) VALUES($1,$2,$3,$4,$5)',
			[
				tenant.rows[0].id,
				locals.session!.userId,
				'research.exported',
				'prospects',
				{ exported: rows.length, excludedForLicense: result.rowCount - rows.length }
			]
		);
		await client.query('COMMIT');
		return new Response(lines.join('\r\n'), {
			headers: {
				'content-type': 'text/csv; charset=utf-8',
				'content-disposition': 'attachment; filename="licensed-prospects.csv"',
				'cache-control': 'private, no-store',
				'x-exported-records': String(rows.length),
				'x-excluded-license': String(result.rowCount - rows.length)
			}
		});
	} catch (error) {
		if (client) await client.query('ROLLBACK').catch(() => undefined);
		return json(
			{ error: error instanceof Error ? error.message : 'Licensed prospect export failed.' },
			{ status: Number((error as any)?.status) || 422 }
		);
	} finally {
		client?.release();
	}
}
