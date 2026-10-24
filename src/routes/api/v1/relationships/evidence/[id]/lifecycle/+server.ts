import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { env } from '$env/dynamic/private';
import { authorizedWorkspace } from '$lib/server/context';
import { getPool } from '$lib/server/database';

const schema = z
	.object({
		tenant: z.string().min(1),
		action: z.enum(['verify', 'dispute', 'mark_stale', 'archive', 'correct']),
		note: z.string().trim().max(1000).default(''),
		correction: z
			.object({
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
				privacyScope: z.enum(['public_source', 'tenant', 'restricted'])
			})
			.optional()
	})
	.strict();
export async function GET({ url, locals, params }) {
	let client: any;
	try {
		const tenantSlug = url.searchParams.get('tenant') || undefined;
		const workspace = await authorizedWorkspace(locals.session, tenantSlug);
		if (!env.DATABASE_URL)
			return json({ events: [] }, { headers: { 'cache-control': 'private, no-store' } });
		if (
			!/^[0-9a-f-]{36}$/i.test(params.id) ||
			!workspace.relationships.some((edge: any) => edge.id === params.id)
		)
			return json({ error: 'Evidence edge not found.' }, { status: 404 });
		const pool = getPool();
		const tenant = await pool.query('SELECT id FROM tenants WHERE slug=$1', [
			locals.session!.tenantSlug
		]);
		if (!tenant.rowCount) return json({ error: 'Tenant not found.' }, { status: 404 });
		client = await pool.connect();
		await client.query('BEGIN');
		await client.query("SELECT set_config('app.tenant_id',$1,true)", [tenant.rows[0].id]);
		const result = await client.query(
			'SELECT e.action,e.before_data AS "before",e.after_data AS "after",e.note,e.created_at AS "createdAt",u.display_name AS "actorName" FROM graph_edge_events e LEFT JOIN users u ON u.id=e.actor_id WHERE e.tenant_id=$1 AND e.edge_id=$2 ORDER BY e.created_at DESC LIMIT 50',
			[tenant.rows[0].id, params.id]
		);
		await client.query('COMMIT');
		return json({ events: result.rows }, { headers: { 'cache-control': 'private, no-store' } });
	} catch (error) {
		if (client) await client.query('ROLLBACK').catch(() => undefined);
		return json(
			{ error: error instanceof Error ? error.message : 'Evidence history unavailable.' },
			{ status: Number((error as any)?.status) || 422 }
		);
	} finally {
		client?.release();
	}
}
export async function POST({ request, locals, params }) {
	let client: any;
	try {
		const body = schema.parse(await request.json());
		const workspace = await authorizedWorkspace(locals.session, body.tenant, true);
		if (
			!/^[0-9a-f-]{36}$/i.test(params.id) ||
			!workspace.relationships.some((edge: any) => edge.id === params.id)
		)
			return json({ error: 'Evidence edge not found.' }, { status: 404 });
		if (!env.DATABASE_URL)
			return json(
				{ error: 'Evidence lifecycle changes require the persistent database.' },
				{ status: 503 }
			);
		if (body.action === 'correct' && !body.correction)
			return json({ error: 'Provide the corrected evidence details.' }, { status: 422 });
		if (body.correction?.sourceUrl && new URL(body.correction.sourceUrl).protocol !== 'https:')
			return json({ error: 'Evidence links must use HTTPS.' }, { status: 422 });
		const pool = getPool();
		const tenant = await pool.query('SELECT id FROM tenants WHERE slug=$1', [
			locals.session!.tenantSlug
		]);
		if (!tenant.rowCount) return json({ error: 'Tenant not found.' }, { status: 404 });
		client = await pool.connect();
		await client.query('BEGIN');
		await client.query("SELECT set_config('app.tenant_id',$1,true)", [tenant.rows[0].id]);
		const edge = await client.query(
			'SELECT * FROM graph_edges WHERE tenant_id=$1 AND id=$2 AND archived_at IS NULL FOR UPDATE',
			[tenant.rows[0].id, params.id]
		);
		if (!edge.rowCount) throw Object.assign(new Error('Evidence edge not found.'), { status: 404 });
		const current = edge.rows[0];
		const before = {
			edgeType: current.edge_type,
			evidenceType: current.evidence_type,
			provenanceLabel: current.provenance_label,
			provenanceUrl: current.provenance_url,
			observedAt: current.observed_at,
			confidence: current.confidence,
			privacyScope: current.privacy_scope,
			verificationStatus: current.verification_status
		};
		let after: any = { ...before };
		let nextId = current.id;
		if (body.action === 'verify') {
			after.verificationStatus = 'verified';
			await client.query(
				"UPDATE graph_edges SET verification_status='verified',last_verified_at=now(),updated_at=now() WHERE tenant_id=$1 AND id=$2",
				[tenant.rows[0].id, current.id]
			);
		} else if (body.action === 'dispute') {
			after.verificationStatus = 'disputed';
			await client.query(
				"UPDATE graph_edges SET verification_status='disputed',updated_at=now() WHERE tenant_id=$1 AND id=$2",
				[tenant.rows[0].id, current.id]
			);
		} else if (body.action === 'mark_stale') {
			after.verificationStatus = 'stale';
			await client.query(
				"UPDATE graph_edges SET verification_status='stale',updated_at=now() WHERE tenant_id=$1 AND id=$2",
				[tenant.rows[0].id, current.id]
			);
		} else if (body.action === 'archive') {
			after.archived = true;
			await client.query(
				'UPDATE graph_edges SET archived_at=now(),updated_at=now() WHERE tenant_id=$1 AND id=$2',
				[tenant.rows[0].id, current.id]
			);
		} else {
			const c = body.correction!;
			const result = await client.query(
				"INSERT INTO graph_edges(tenant_id,from_id,to_id,edge_type,evidence_type,provenance_url,provenance_label,observed_at,confidence,privacy_scope,verification_status,supersedes_id,source_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'unverified',$11,$12) RETURNING id",
				[
					tenant.rows[0].id,
					current.from_id,
					current.to_id,
					current.edge_type,
					c.evidenceType,
					c.sourceUrl || null,
					c.provenanceLabel,
					c.observedAt || null,
					c.confidence,
					c.privacyScope,
					current.id,
					current.source_id || null
				]
			);
			nextId = result.rows[0].id;
			after = { ...c, verificationStatus: 'unverified', supersedesId: current.id };
			await client.query(
				"UPDATE graph_edges SET verification_status='stale',updated_at=now() WHERE tenant_id=$1 AND id=$2",
				[tenant.rows[0].id, current.id]
			);
		}
		await client.query(
			'INSERT INTO graph_edge_events(tenant_id,edge_id,action,actor_id,before_data,after_data,note) VALUES($1,$2,$3,$4,$5,$6,$7)',
			[
				tenant.rows[0].id,
				current.id,
				body.action === 'verify'
					? 'verified'
					: body.action === 'dispute'
						? 'disputed'
						: body.action === 'mark_stale'
							? 'marked_stale'
							: body.action === 'archive'
								? 'archived'
								: 'corrected',
				locals.session!.userId,
				before,
				after,
				body.note
			]
		);
		await client.query(
			'INSERT INTO audit_log(tenant_id,actor_id,action,resource,record_id,details) VALUES($1,$2,$3,$4,$5,$6)',
			[
				tenant.rows[0].id,
				locals.session!.userId,
				`graph_edge.${body.action}`,
				'graph_edges',
				current.id,
				{ newEdgeId: nextId, note: body.note }
			]
		);
		await client.query('COMMIT');
		return json(
			{ ok: true, id: nextId, action: body.action, edge: after },
			{ headers: { 'cache-control': 'private, no-store' } }
		);
	} catch (error) {
		if (client) await client.query('ROLLBACK').catch(() => undefined);
		return json(
			{ error: error instanceof Error ? error.message : 'Evidence update failed.' },
			{ status: Number((error as any)?.status) || 422 }
		);
	} finally {
		client?.release();
	}
}
