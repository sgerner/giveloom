import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { env } from '$env/dynamic/private';
import { authorizedWorkspace } from '$lib/server/context';
import { tenantTransaction } from '$lib/server/tenant-service';
import { relationshipPaths } from '$lib/server/research';

const schema = z
	.object({
		tenant: z.string(),
		fromId: z.string().uuid(),
		toId: z.string().uuid(),
		depth: z.number().int().min(1).max(3).default(2),
		dateFrom: z.string().date().optional(),
		dateTo: z.string().date().optional(),
		evidenceType: z
			.enum(['public_filing', 'organization_page', 'tenant_note', 'donor_confirmed', 'other'])
			.optional(),
		sourceId: z.string().uuid().optional(),
		confidenceAtLeast: z
			.enum(['confirmed', 'high', 'medium', 'low', 'possible'])
			.default('possible')
	})
	.strict();

function errorResponse(error: unknown) {
	const value = error as { status?: number; name?: string };
	return json(
		{ error: error instanceof Error ? error.message : 'Path search failed.' },
		{ status: Number(value?.status) || (value?.name === 'ZodError' ? 422 : 422) }
	);
}

export async function POST({ request, locals }) {
	try {
		const body = schema.parse(await request.json());
		if (!locals.session) throw Object.assign(new Error('Sign in first.'), { status: 401 });
		if (body.tenant !== locals.session.tenantSlug)
			throw Object.assign(new Error('Tenant access denied.'), { status: 403 });
		if (body.fromId === body.toId)
			throw Object.assign(new Error('Choose two different records.'), { status: 422 });
		if (body.dateFrom && body.dateTo && body.dateFrom > body.dateTo)
			throw Object.assign(new Error('The start date must be before the end date.'), {
				status: 422
			});
		if (!env.DATABASE_URL) {
			const workspace = await authorizedWorkspace(locals.session, body.tenant);
			const ids = new Set(
				[
					...workspace.contacts,
					...workspace.prospects,
					...workspace.organizations,
					...workspace.households,
					...workspace.events
				].map((item: any) => item.id)
			);
			if (!ids.has(body.fromId) || !ids.has(body.toId))
				return json({ error: 'Both records must belong to your workspace.' }, { status: 404 });
			const ranks = ['confirmed', 'high', 'medium', 'low', 'possible'],
				threshold = ranks.indexOf(body.confidenceAtLeast);
			const filtered = workspace.relationships.filter((edge: any) => {
				if (edge.archivedAt || ['stale', 'disputed'].includes(edge.verificationStatus || ''))
					return false;
				if (
					edge.sourceId &&
					(!edge.sourceEnabled ||
						!(edge.permittedUses || []).some(
							(use: string) => use === 'research' || use === 'internal_review'
						))
				)
					return false;
				if (
					['public_filing', 'organization_page'].includes(edge.evidenceType || '') &&
					!edge.sourceId
				)
					return false;
				if (ranks.indexOf(edge.confidence || 'possible') > threshold) return false;
				if (body.evidenceType && edge.evidenceType !== body.evidenceType) return false;
				if (body.sourceId && edge.sourceId !== body.sourceId) return false;
				if (body.dateFrom || body.dateTo) {
					if (!edge.observedAt) return false;
					const day = new Date(edge.observedAt).toISOString().slice(0, 10);
					if (body.dateFrom && day < body.dateFrom) return false;
					if (body.dateTo && day > body.dateTo) return false;
				}
				return true;
			});
			return json(
				{
					paths: relationshipPaths(filtered as any, body.fromId, body.toId, body.depth),
					truncated: false,
					explanation: 'Paths describe documented affiliations, not verified social familiarity.'
				},
				{ headers: { 'cache-control': 'private, no-store' } }
			);
		}
		return await tenantTransaction(locals.session, null, async (client, tenant) => {
			const node = await client.query(
				`SELECT EXISTS(SELECT 1 FROM contacts WHERE tenant_id=$1 AND id=$2 AND archived_at IS NULL AND merged_into IS NULL) OR EXISTS(SELECT 1 FROM prospects WHERE tenant_id=$1 AND id=$2) OR EXISTS(SELECT 1 FROM workspace_records WHERE tenant_id=$1 AND id=$2 AND resource IN('organizations','households','events') AND archived_at IS NULL) AS found`,
				[tenant.id, body.fromId]
			);
			const target = await client.query(
				`SELECT EXISTS(SELECT 1 FROM contacts WHERE tenant_id=$1 AND id=$2 AND archived_at IS NULL AND merged_into IS NULL) OR EXISTS(SELECT 1 FROM prospects WHERE tenant_id=$1 AND id=$2) OR EXISTS(SELECT 1 FROM workspace_records WHERE tenant_id=$1 AND id=$2 AND resource IN('organizations','households','events') AND archived_at IS NULL) AS found`,
				[tenant.id, body.toId]
			);
			if (!node.rows[0].found || !target.rows[0].found)
				throw Object.assign(new Error('Both records must belong to your workspace.'), {
					status: 404
				});
			const ranks = ['confirmed', 'high', 'medium', 'low', 'possible'];
			const baseValues: any[] = [tenant.id];
			let filters =
				"e.tenant_id=$1 AND e.archived_at IS NULL AND e.verification_status NOT IN('stale','disputed') AND (e.privacy_scope='public_source' OR e.privacy_scope='tenant' AND $2::text NOT IN('volunteer','board_member') OR e.privacy_scope='restricted' AND $2::text IN('owner','admin')) AND array_position(ARRAY['confirmed','high','medium','low','possible']::text[],e.confidence)<=array_position(ARRAY['confirmed','high','medium','low','possible']::text[],$3::text) AND (e.source_id IS NULL OR (rs.enabled AND (rs.permitted_uses && ARRAY['research','internal_review']::text[]))) AND (e.evidence_type NOT IN('public_filing','organization_page') OR e.source_id IS NOT NULL)";
			baseValues.push(locals.session!.role, body.confidenceAtLeast);
			if (body.evidenceType) {
				baseValues.push(body.evidenceType);
				filters += ` AND e.evidence_type=$${baseValues.length}`;
			}
			if (body.sourceId) {
				baseValues.push(body.sourceId);
				filters += ` AND e.source_id=$${baseValues.length}`;
			}
			if (body.dateFrom) {
				baseValues.push(body.dateFrom);
				filters += ` AND e.observed_at >= $${baseValues.length}::date`;
			}
			if (body.dateTo) {
				baseValues.push(body.dateTo);
				filters += ` AND e.observed_at < ($${baseValues.length}::date + interval '1 day')`;
			}
			const foundEdges = new Map<string, any>();
			let frontier = [body.fromId];
			const visited = new Set([body.fromId]);
			let truncated = false;
			for (let hop = 0; hop < body.depth && frontier.length; hop++) {
				if (frontier.length > 500) {
					frontier = frontier.slice(0, 500);
					truncated = true;
				}
				const params = [...baseValues, frontier];
				const result = await client.query(
					`SELECT e.id,e.from_id AS "fromId",e.to_id AS "toId",e.edge_type AS kind,e.evidence_type AS "evidenceType",e.provenance_label AS evidence,e.provenance_url AS "sourceUrl",e.observed_at AS "observedAt",e.confidence,e.privacy_scope AS "privacyScope",e.verification_status AS "verificationStatus",e.source_id AS "sourceId",rs.name AS "sourceName",rs.license_label AS "sourceLicense",rs.permitted_uses AS "permittedUses",rs.enabled AS "sourceEnabled",rs.export_allowed AS "exportAllowed",rs.outreach_allowed AS "outreachAllowed" FROM graph_edges e LEFT JOIN research_sources rs ON rs.tenant_id=e.tenant_id AND rs.id=e.source_id WHERE ${filters} AND (e.from_id=ANY($${params.length}::uuid[]) OR e.to_id=ANY($${params.length}::uuid[])) ORDER BY e.created_at DESC,e.id DESC LIMIT 1001`,
					params
				);
				if (result.rows.length > 1000) truncated = true;
				const next: string[] = [];
				for (const edge of result.rows.slice(0, 1000)) {
					foundEdges.set(edge.id, edge);
					const neighbor =
						edge.fromId === frontier[0] || frontier.includes(edge.fromId) ? edge.toId : edge.fromId;
					if (!visited.has(neighbor)) {
						visited.add(neighbor);
						next.push(neighbor);
					}
				}
				frontier = next;
			}
			const paths = relationshipPaths([...foundEdges.values()], body.fromId, body.toId, body.depth);
			return json(
				{
					paths,
					truncated,
					explanation: 'Paths describe documented affiliations, not verified social familiarity.'
				},
				{ headers: { 'cache-control': 'private, no-store' } }
			);
		});
	} catch (error) {
		return errorResponse(error);
	}
}
