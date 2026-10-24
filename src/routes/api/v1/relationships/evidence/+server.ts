import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { env } from '$env/dynamic/private';
import { authorizedWorkspace } from '$lib/server/context';
import { tenantTransaction } from '$lib/server/tenant-service';
import { applyMutation } from '$lib/server/store';
import {
	canViewGraphEvidence,
	graphEdgeTypes,
	validateGraphEvidence
} from '$lib/server/intelligence';

const schema = z
	.object({
		tenant: z.string().min(1),
		fromId: z.string().uuid(),
		toId: z.string().uuid(),
		kind: z.enum(graphEdgeTypes),
		evidenceType: z.enum([
			'public_filing',
			'organization_page',
			'tenant_note',
			'donor_confirmed',
			'other'
		]),
		provenanceLabel: z.string().trim().min(3).max(300),
		sourceUrl: z.string().url().optional(),
		observedAt: z.string().datetime().optional(),
		confidence: z.enum(['confirmed', 'high', 'medium', 'low', 'possible']),
		privacyScope: z.enum(['public_source', 'tenant', 'restricted']).default('tenant'),
		sourceId: z.string().uuid().optional()
	})
	.strict();

function errorResponse(error: unknown, fallback: string) {
	return json(
		{ error: error instanceof Error ? error.message : fallback },
		{
			status:
				Number((error as { status?: number })?.status) ||
				((error as { name?: string })?.name === 'ZodError' ? 422 : 422)
		}
	);
}

export async function GET({ url, locals }) {
	try {
		const tenantSlug = url.searchParams.get('tenant') || undefined;
		if (!locals.session) throw Object.assign(new Error('Sign in first.'), { status: 401 });
		if (tenantSlug && tenantSlug !== locals.session.tenantSlug)
			throw Object.assign(new Error('The requested tenant is not in your active session.'), {
				status: 403
			});
		if (!env.DATABASE_URL) {
			const workspace = await authorizedWorkspace(locals.session, tenantSlug);
			const edges = workspace.relationships.filter((edge: any) =>
				canViewGraphEvidence(locals.session!.role, edge.privacyScope || 'tenant')
			);
			return json(
				{ edges, nodes: [], nextCursor: null },
				{ headers: { 'cache-control': 'private, no-store' } }
			);
		}
		const limit = Math.min(250, Math.max(1, Number(url.searchParams.get('limit')) || 100));
		const q = (url.searchParams.get('nodeQuery') || '').trim().slice(0, 100);
		const cursor = url.searchParams.get('cursor');
		return await tenantTransaction(locals.session, null, async (client, tenant) => {
			const values: unknown[] = [tenant.id];
			let predicate = 'e.tenant_id=$1';
			const role = locals.session!.role;
			predicate +=
				role === 'owner' || role === 'admin'
					? " AND e.privacy_scope IN('public_source','tenant','restricted')"
					: ['volunteer', 'board_member'].includes(role)
						? " AND e.privacy_scope='public_source'"
						: " AND e.privacy_scope IN('public_source','tenant')";
			if (cursor) {
				let decoded: { createdAt?: string; id?: string };
				try {
					decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString());
				} catch {
					throw Object.assign(new Error('The evidence cursor is invalid.'), { status: 400 });
				}
				if (
					!decoded.createdAt ||
					!Number.isFinite(Date.parse(decoded.createdAt)) ||
					!z.string().uuid().safeParse(decoded.id).success
				)
					throw Object.assign(new Error('The evidence cursor is invalid.'), { status: 400 });
				values.push(decoded.createdAt, decoded.id);
				predicate += ` AND (e.created_at,e.id)<($${values.length - 1}::timestamptz,$${values.length}::uuid)`;
			}
			values.push(limit + 1);
			const result = await client.query(
				`
				SELECT e.id,e.from_id AS "fromId",e.to_id AS "toId",e.edge_type AS kind,
				 e.evidence_type AS "evidenceType",e.provenance_label AS evidence,e.provenance_url AS "sourceUrl",
				 e.observed_at AS "observedAt",e.confidence,e.privacy_scope AS "privacyScope",
				 e.verification_status AS "verificationStatus",e.last_verified_at AS "lastVerifiedAt",
				 e.archived_at AS "archivedAt",e.supersedes_id AS "supersedesId",e.source_id AS "sourceId",
				 e.created_at AS "createdAt",e.created_at::text AS "createdAtCursor",f.node_type AS "fromNodeType",f.display_name AS "fromName",
				 f.source_resource AS "fromResource",t.node_type AS "toNodeType",t.display_name AS "toName",
				 t.source_resource AS "toResource",rs.name AS "sourceName",rs.license_label AS "sourceLicense",
				 rs.permitted_uses AS "permittedUses",rs.export_allowed AS "exportAllowed",
				 rs.outreach_allowed AS "outreachAllowed",rs.enabled AS "sourceEnabled"
				FROM graph_edges e
				LEFT JOIN graph_nodes f ON f.tenant_id=e.tenant_id AND f.entity_id=e.from_id
				LEFT JOIN graph_nodes t ON t.tenant_id=e.tenant_id AND t.entity_id=e.to_id
				LEFT JOIN research_sources rs ON rs.tenant_id=e.tenant_id AND rs.id=e.source_id
				WHERE ${predicate} ORDER BY e.created_at DESC,e.id DESC LIMIT $${values.length}
			`,
				values
			);
			const visible = result.rows.slice(0, limit);
			const last = visible.at(-1);
			const nextCursor =
				result.rows.length > limit && last
					? Buffer.from(JSON.stringify({ createdAt: last.createdAtCursor, id: last.id })).toString(
							'base64url'
						)
					: null;
			const nodeValues: unknown[] = [tenant.id];
			const contactFilter = q ? " AND lower(c.name) LIKE lower($2) || '%'" : '';
			const prospectFilter = q ? " AND lower(p.name) LIKE lower($2) || '%'" : '';
			const recordFilter = q
				? " AND lower(COALESCE(w.data->>'name','')) LIKE lower($2) || '%'"
				: '';
			if (q) nodeValues.push(q);
			nodeValues.push(q ? 100 : 80);
			const nodeRows = await client.query(
				`
				SELECT id,name,"nodeKind","sourceResource" FROM (
				 SELECT c.id,c.name,'person' AS "nodeKind",'contacts' AS "sourceResource"
				 FROM contacts c WHERE c.tenant_id=$1 AND c.archived_at IS NULL AND c.merged_into IS NULL${contactFilter}
				 UNION ALL
				 SELECT p.id,p.name,CASE WHEN lower(COALESCE(p.data->>'recordType','')) LIKE '%foundation%' THEN 'foundation'
				 WHEN lower(COALESCE(p.data->>'recordType','')) LIKE '%organization%' THEN 'organization' ELSE 'person' END,
				 'prospects' AS "sourceResource" FROM prospects p WHERE p.tenant_id=$1${prospectFilter}
				 UNION ALL
				 SELECT w.id,COALESCE(w.data->>'name','Unnamed record'),
				 CASE WHEN w.resource='households' THEN 'household' WHEN w.resource='events' THEN 'event' ELSE 'organization' END,
				 w.resource AS "sourceResource" FROM workspace_records w WHERE w.tenant_id=$1
				 AND w.resource IN('organizations','households','events') AND w.archived_at IS NULL${recordFilter}
				) available_nodes ORDER BY lower(name),id LIMIT $${nodeValues.length}
			`,
				nodeValues
			);
			const edgeNodes = visible.flatMap((edge: any) => [
				{
					id: edge.fromId,
					name: edge.fromName || 'Unknown record',
					nodeKind: edge.fromNodeType || 'person',
					sourceResource: edge.fromResource
				},
				{
					id: edge.toId,
					name: edge.toName || 'Unknown record',
					nodeKind: edge.toNodeType || 'organization',
					sourceResource: edge.toResource
				}
			]);
			return json(
				{ edges: visible, nextCursor, nodes: [...nodeRows.rows, ...edgeNodes] },
				{ headers: { 'cache-control': 'private, no-store' } }
			);
		});
	} catch (error) {
		return errorResponse(error, 'Relationship evidence unavailable.');
	}
}

export async function POST({ request, locals }) {
	try {
		const body = schema.parse(await request.json());
		if (!locals.session) throw Object.assign(new Error('Sign in first.'), { status: 401 });
		if (body.tenant !== locals.session.tenantSlug)
			throw Object.assign(new Error('Tenant access denied.'), { status: 403 });
		if (body.fromId === body.toId)
			return json({ error: 'A connection must link two different records.' }, { status: 422 });
		validateGraphEvidence({
			kind: body.kind,
			evidence: body.provenanceLabel,
			sourceUrl: body.sourceUrl,
			evidenceType: body.evidenceType
		});
		if (!env.DATABASE_URL) {
			const workspace = await authorizedWorkspace(locals.session, body.tenant, true);
			const ids = new Set(
				[
					...workspace.contacts,
					...workspace.prospects,
					...workspace.organizations,
					...workspace.households,
					...workspace.events
				].map((x: any) => x.id)
			);
			if (!ids.has(body.fromId) || !ids.has(body.toId))
				return json({ error: 'Both records must belong to your workspace.' }, { status: 404 });
			const result = await applyMutation(
				body.tenant,
				'relationships',
				{
					fromId: body.fromId,
					toId: body.toId,
					kind: body.kind,
					evidence: body.provenanceLabel,
					evidenceType: body.evidenceType,
					sourceUrl: body.sourceUrl,
					observedAt: body.observedAt,
					confidence: body.confidence,
					privacyScope: body.privacyScope
				},
				'create',
				locals.session.role
			);
			return json({ edge: result.item }, { status: 201 });
		}
		return await tenantTransaction(locals.session, null, async (client, tenant) => {
			if (!['owner', 'admin', 'fundraising_manager', 'fundraiser'].includes(tenant.role))
				throw Object.assign(new Error('Your role cannot perform this action.'), { status: 403 });
			const lookup = async (id: string) => {
				const found = await client.query(
					`SELECT id,name,resource,node_type AS "nodeType" FROM (
				 SELECT c.id,c.name,'contacts' AS resource,'person' AS node_type FROM contacts c WHERE c.tenant_id=$1 AND c.id=$2 AND c.archived_at IS NULL AND c.merged_into IS NULL
				 UNION ALL SELECT p.id,p.name,'prospects' AS resource,CASE WHEN lower(COALESCE(p.data->>'recordType','')) LIKE '%foundation%' THEN 'foundation' WHEN lower(COALESCE(p.data->>'recordType','')) LIKE '%organization%' THEN 'organization' ELSE 'person' END FROM prospects p WHERE p.tenant_id=$1 AND p.id=$2
				 UNION ALL SELECT w.id,COALESCE(w.data->>'name','Unnamed record'),w.resource,CASE WHEN w.resource='households' THEN 'household' WHEN w.resource='events' THEN 'event' ELSE 'organization' END FROM workspace_records w WHERE w.tenant_id=$1 AND w.id=$2 AND w.resource IN('organizations','households','events') AND w.archived_at IS NULL
				) records LIMIT 1`,
					[tenant.id, id]
				);
				if (!found.rowCount)
					throw Object.assign(new Error('Graph node is not in this tenant.'), { status: 404 });
				return found.rows[0];
			};
			const from = await lookup(body.fromId),
				to = await lookup(body.toId);
			if (['public_filing', 'organization_page'].includes(body.evidenceType) && !body.sourceId)
				throw Object.assign(
					new Error('Public evidence must be tied to a registered research source.'),
					{ status: 422 }
				);
			if (body.sourceId) {
				const source = await client.query(
					"SELECT source_url AS \"sourceUrl\" FROM research_sources WHERE tenant_id=$1 AND id=$2 AND enabled=true AND ('research'=ANY(permitted_uses) OR 'internal_review'=ANY(permitted_uses))",
					[tenant.id, body.sourceId]
				);
				if (!source.rowCount)
					throw Object.assign(
						new Error('Choose an enabled source that permits research or internal review.'),
						{ status: 422 }
					);
				if (
					body.sourceUrl &&
					(!source.rows[0].sourceUrl ||
						new URL(body.sourceUrl).hostname !== new URL(source.rows[0].sourceUrl).hostname)
				)
					throw Object.assign(new Error('Evidence URL must use the registered source domain.'), {
						status: 422
					});
			}
			for (const [id, node] of [
				[body.fromId, from],
				[body.toId, to]
			] as const)
				await client.query(
					'INSERT INTO graph_nodes(tenant_id,entity_id,node_type,display_name,source_resource,privacy_scope) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(tenant_id,entity_id) DO UPDATE SET node_type=EXCLUDED.node_type,display_name=EXCLUDED.display_name,source_resource=EXCLUDED.source_resource,updated_at=now()',
					[tenant.id, id, node.nodeType, node.name, node.resource, body.privacyScope]
				);
			const result = await client.query(
				`INSERT INTO graph_edges(tenant_id,from_id,to_id,edge_type,evidence_type,provenance_url,provenance_label,observed_at,confidence,privacy_scope,verification_status,source_id)
				VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'unverified',$11)
				RETURNING id,from_id AS "fromId",to_id AS "toId",edge_type AS kind,evidence_type AS "evidenceType",provenance_label AS evidence,provenance_url AS "sourceUrl",observed_at AS "observedAt",confidence,privacy_scope AS "privacyScope",verification_status AS "verificationStatus",source_id AS "sourceId"`,
				[
					tenant.id,
					body.fromId,
					body.toId,
					body.kind,
					body.evidenceType,
					body.sourceUrl || null,
					body.provenanceLabel,
					body.observedAt || null,
					body.confidence,
					body.privacyScope,
					body.sourceId || null
				]
			);
			return json(
				{ edge: result.rows[0] },
				{ status: 201, headers: { 'cache-control': 'private, no-store' } }
			);
		});
	} catch (error) {
		return errorResponse(error, 'Relationship evidence could not be saved.');
	}
}
