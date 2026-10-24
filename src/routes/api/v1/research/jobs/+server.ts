import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { env } from '$env/dynamic/private';
import { authorizedWorkspace } from '$lib/server/context';
import { parse990PF, unpack990PFArchive } from '$lib/server/research';
import { getPool } from '$lib/server/database';

const schema = z
	.object({
		tenant: z.string(),
		sourceId: z.string().uuid().optional(),
		selectedFingerprints: z
			.array(z.string().regex(/^[a-f0-9]{64}$/))
			.max(1000)
			.optional(),
		xml: z
			.string()
			.max(5 * 1024 * 1024)
			.optional(),
		archiveBase64: z.string().max(7_000_000).optional(),
		sourceUrl: z.string().url().optional(),
		apply: z.boolean().default(false)
	})
	.strict()
	.refine(
		(value) => Boolean(value.xml) !== Boolean(value.archiveBase64),
		'Provide either one XML filing or one ZIP archive.'
	);

export async function POST({ request, locals }) {
	try {
		const body = schema.parse(await request.json());
		const workspace = await authorizedWorkspace(locals.session, body.tenant, true);
		if (workspace.tenant.demo && body.apply)
			throw new Error('Demo mode only previews filing imports; no real prospect data is saved.');
		if (!env.DATABASE_URL && body.apply)
			throw Object.assign(
				new Error('IRS filing imports require persistent storage and a registered source.'),
				{ status: 503 }
			);
		const pool = env.DATABASE_URL ? getPool() : null;
		const tenant = pool
			? await pool.query('SELECT id FROM tenants WHERE slug=$1', [locals.session!.tenantSlug])
			: null;
		if (pool && !tenant?.rowCount) throw new Error('Tenant not found.');
		const tenantId = tenant?.rows[0]?.id as string | undefined;
		let source: any = null;
		let records: any[] = [];
		if (body.sourceId) {
			if (!pool || !tenant)
				throw Object.assign(new Error('A registered source requires persistent storage.'), {
					status: 503
				});
			const client = await pool.connect();
			try {
				await client.query('BEGIN');
				await client.query("SELECT set_config('app.tenant_id',$1,true)", [tenantId]);
				const result = await client.query(
					'SELECT id,name,source_type AS "sourceType",source_url AS "sourceUrl",license_label AS "licenseLabel",permitted_uses AS "permittedUses",export_allowed AS "exportAllowed",outreach_allowed AS "outreachAllowed",enabled FROM research_sources WHERE tenant_id=$1 AND id=$2 FOR SHARE',
					[tenantId, body.sourceId]
				);
				if (!result.rowCount)
					throw Object.assign(
						new Error('Register this source in the tenant source catalog first.'),
						{ status: 422 }
					);
				source = result.rows[0];
				if (
					!source.enabled ||
					source.sourceType !== 'public_filing' ||
					!source.permittedUses.includes('research')
				)
					throw Object.assign(
						new Error('The registered source is disabled or does not permit research use.'),
						{ status: 403 }
					);
				if (source.outreachAllowed)
					throw Object.assign(new Error('Public filing sources cannot authorize outreach.'), {
						status: 422
					});
				await client.query('COMMIT');
			} catch (error) {
				await client.query('ROLLBACK');
				throw error;
			} finally {
				client.release();
			}
		}
		if (body.apply && !source)
			throw Object.assign(
				new Error('Select a registered, licensed source before importing reviewed records.'),
				{ status: 422 }
			);
		const fallbackUrl = body.sourceUrl || source?.sourceUrl;
		if (!fallbackUrl)
			throw Object.assign(
				new Error('The source catalog entry must include the original IRS URL.'),
				{ status: 422 }
			);
		const sourceHost = new URL(fallbackUrl).hostname;
		if (!['www.irs.gov', 'apps.irs.gov', 'irs.gov'].includes(sourceHost))
			throw Object.assign(new Error('IRS imports must use an official IRS URL.'), { status: 422 });
		const filings = body.xml
			? [{ name: 'uploaded-return.xml', xml: body.xml }]
			: unpack990PFArchive(Buffer.from(body.archiveBase64!, 'base64'));
		for (const filing of filings) {
			const url = new URL(fallbackUrl);
			if (filing.name !== 'uploaded-return.xml')
				url.hash = `file=${encodeURIComponent(filing.name)}`;
			const parsed = parse990PF(filing.xml, url.toString());
			for (const item of parsed) {
				item.sourceId = source?.id;
				item.evidence = item.evidence.map((evidence) => ({
					...evidence,
					sourceName: `${source?.name ? source.name + ' · ' : ''}${evidence.sourceName}`,
					...(source?.id
						? {
								sourceId: source.id,
								sourceLicense: source.licenseLabel,
								permittedUses: source.permittedUses,
								exportAllowed: source.exportAllowed,
								outreachAllowed: false
							}
						: {})
				}));
				records.push(item);
			}
		}
		records = [
			...new Map(
				records.map((record) => [record.sourceFingerprint + ':' + record.sourceVersion, record])
			).values()
		];
		const ready = records.filter(
			(record) =>
				!workspace.prospects.some(
					(existing) =>
						existing.sourceFingerprint === record.sourceFingerprint &&
						(!existing.sourceVersion || existing.sourceVersion === record.sourceVersion)
				)
		);
		const duplicates = records.length - ready.length;
		const reviewed = body.selectedFingerprints
			? ready.filter((record) => body.selectedFingerprints!.includes(record.sourceFingerprint))
			: ready;
		if (body.apply) {
			if (!body.selectedFingerprints?.length)
				throw Object.assign(new Error('Explicitly select reviewed candidates before import.'), {
					status: 422
				});
			if (!reviewed.length)
				throw Object.assign(new Error('Select at least one candidate for import review.'), {
					status: 422
				});
			const client = await pool!.connect();
			try {
				await client.query('BEGIN');
				await client.query("SELECT set_config('app.tenant_id',$1,true)", [tenantId]);
				for (const record of reviewed) {
					const previous = await client.query(
						'SELECT id FROM research_filing_versions WHERE tenant_id=$1 AND filing_key=$2 AND source_version<>$3 ORDER BY received_at DESC LIMIT 1',
						[tenantId, record.filingKey, record.sourceVersion]
					);
					const prospect = await client.query(
						'INSERT INTO prospects(tenant_id,name,stage,match_status,data) VALUES($1,$2,$3,$4,$5) RETURNING id',
						[tenantId, record.name, record.stage, record.matchStatus, record]
					);
					for (const evidence of record.evidence)
						await client.query(
							"INSERT INTO prospect_evidence(tenant_id,prospect_id,source_name,source_url,evidence_type,confidence,observed_at,license,data,source_id) VALUES($1,$2,$3,$4,'public_filing',$5,$6,$7,$8,$9)",
							[
								tenantId,
								prospect.rows[0].id,
								evidence.sourceName,
								evidence.sourceUrl,
								evidence.confidence,
								evidence.observedAt,
								source.licenseLabel,
								{
									reason: record.reason,
									outreachAllowed: false,
									sourceId: source.id,
									permittedUses: source.permittedUses,
									exportAllowed: source.exportAllowed
								},
								source.id
							]
						);
					await client.query(
						'INSERT INTO research_filing_versions(tenant_id,prospect_id,filing_key,source_fingerprint,source_version,source_url,filing_year,filing_status,received_at,supersedes_id,source_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(tenant_id,prospect_id,source_version) DO NOTHING',
						[
							tenantId,
							prospect.rows[0].id,
							record.filingKey,
							record.sourceFingerprint,
							record.sourceVersion,
							record.evidence[0].sourceUrl,
							record.filingYear,
							record.filingStatus,
							record.versionReceivedAt,
							previous.rows[0]?.id || null,
							source.id
						]
					);
				}
				const version = records[0]?.sourceVersion || 'empty';
				await client.query(
					'INSERT INTO research_import_batches(tenant_id,source_id,imported_by,source_version,records_seen,records_imported,duplicates) VALUES($1,$2,$3,$4,$5,$6,$7)',
					[
						tenantId,
						source.id,
						locals.session!.userId,
						version,
						records.length,
						reviewed.length,
						duplicates
					]
				);
				await client.query(
					'INSERT INTO audit_log(tenant_id,actor_id,action,resource,details) VALUES($1,$2,$3,$4,$5)',
					[
						tenantId,
						locals.session!.userId,
						'research.filing_imported',
						'research_filing_versions',
						{ count: reviewed.length, sourceId: source.id, sourceUrl: fallbackUrl }
					]
				);
				await client.query('COMMIT');
			} catch (error) {
				await client.query('ROLLBACK');
				throw error;
			} finally {
				client.release();
			}
		}
		const displayRecords = records.map((record) => ({
			...record,
			duplicate: !ready.some(
				(item) =>
					item.sourceFingerprint === record.sourceFingerprint &&
					item.sourceVersion === record.sourceVersion
			)
		}));
		return json(
			{
				ok: true,
				dryRun: !body.apply,
				records: displayRecords,
				ready: ready.length,
				duplicates,
				imported: body.apply ? reviewed.length : 0,
				source: source
					? {
							id: source.id,
							name: source.name,
							licenseLabel: source.licenseLabel,
							exportAllowed: source.exportAllowed
						}
					: null,
				warning:
					'Affiliations and grants are evidence, not contact permission. Names are not automatically merged.'
			},
			{ headers: { 'cache-control': 'private, no-store' } }
		);
	} catch (error) {
		return json(
			{ error: error instanceof Error ? error.message : 'Research import failed' },
			{ status: Number((error as any)?.status) || 422 }
		);
	}
}
