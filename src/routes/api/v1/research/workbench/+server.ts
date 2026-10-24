import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { env } from '$env/dynamic/private';
import { authorizedWorkspace } from '$lib/server/context';
import { getPool } from '$lib/server/database';

const weightsSchema = z
	.object({
		affinity: z.number().int().min(0).max(100),
		philanthropy: z.number().int().min(0).max(100),
		connection: z.number().int().min(0).max(100),
		recency: z.number().int().min(0).max(100),
		geography: z.number().int().min(0).max(100)
	})
	.strict()
	.refine(
		(v) => Object.values(v).reduce((a, b) => a + b, 0) === 100,
		'Weights must add up to 100.'
	);
const sourceSchema = z
	.object({
		name: z.string().trim().min(2).max(180),
		sourceType: z.enum(['public_filing', 'licensed_provider', 'manual', 'other']),
		sourceUrl: z.string().url().optional(),
		licenseLabel: z.string().trim().min(2).max(240),
		permittedUses: z
			.array(z.enum(['research', 'scoring', 'internal_review', 'export', 'outreach']))
			.max(5),
		exportAllowed: z.boolean().default(false),
		outreachAllowed: z.boolean().default(false),
		enabled: z.boolean().default(true),
		notes: z.string().max(2000).default('')
	})
	.strict();
const sourceUpdateSchema = z.object({ id: z.string().uuid(), enabled: z.boolean() }).strict();
const queueSchema = z
	.object({
		title: z.string().trim().min(2).max(180),
		criteria: z.record(z.string(), z.unknown()).default({}),
		sourceIds: z.array(z.string().uuid()).min(1).max(30),
		budgetCapMinor: z.number().int().min(0).max(1000000000).default(0),
		currency: z.string().length(3).default('USD'),
		assignedTo: z.string().uuid().optional(),
		dueAt: z.string().datetime().optional()
	})
	.strict();
const controlSchema = z
	.object({
		prospectId: z.string().uuid(),
		excluded: z.boolean(),
		optedOut: z.boolean(),
		reason: z.string().trim().min(3).max(1000)
	})
	.strict();
const queueStatusSchema = z
	.object({
		id: z.string().uuid(),
		status: z.enum(['in_progress', 'ready_for_review', 'completed', 'cancelled']),
		outcome: z.string().max(2000).default('')
	})
	.strict();
const reviewSchema = z
	.object({
		prospectId: z.string().uuid(),
		decision: z.enum(['accepted', 'rejected']),
		reason: z.string().trim().min(3).max(1000)
	})
	.strict();
const mergeSchema = z
	.object({
		primaryId: z.string().uuid(),
		duplicateId: z.string().uuid(),
		reason: z.string().trim().min(3).max(1000)
	})
	.strict();
const splitSchema = z
	.object({ prospectId: z.string().uuid(), reason: z.string().trim().min(3).max(1000) })
	.strict();
const stageSchema = z
	.object({
		prospectId: z.string().uuid(),
		stage: z.enum([
			'discovered',
			'screened',
			'qualified',
			'assigned',
			'introduction_requested',
			'contacted',
			'meeting',
			'solicited',
			'committed',
			'donated',
			'stewarded',
			'rejected'
		]),
		reason: z.string().trim().min(3).max(1000)
	})
	.strict();
async function scoped(session: any, fn: (client: any, tenantId: string) => Promise<any>) {
	const pool = getPool();
	const t = await pool.query('SELECT id FROM tenants WHERE slug=$1', [session.tenantSlug]);
	if (!t.rowCount) throw Object.assign(new Error('Tenant not found.'), { status: 404 });
	const client = await pool.connect();
	try {
		await client.query('BEGIN');
		await client.query("SELECT set_config('app.tenant_id',$1,true)", [t.rows[0].id]);
		const member = await client.query(
			"SELECT role FROM memberships WHERE tenant_id=$1 AND user_id=$2 AND status='active'",
			[t.rows[0].id, session.userId]
		);
		if (!member.rowCount)
			throw Object.assign(new Error('Your tenant membership is no longer active.'), {
				status: 403
			});
		const result = await fn(client, t.rows[0].id);
		await client.query('COMMIT');
		return result;
	} catch (e) {
		await client.query('ROLLBACK');
		throw e;
	} finally {
		client.release();
	}
}
export async function GET({ url, locals }) {
	try {
		await authorizedWorkspace(locals.session, url.searchParams.get('tenant') || undefined);
		if (!env.DATABASE_URL)
			return json(
				{
					sources: [],
					queue: [],
					controls: [],
					funnel: [],
					transitions: [],
					members: [],
					weights: { affinity: 35, philanthropy: 25, connection: 20, recency: 10, geography: 10 }
				},
				{ headers: { 'cache-control': 'private, no-store' } }
			);
		const data = await scoped(locals.session, async (c: any, t: string) => {
			const [sources, queue, controls, pref, funnel, transitions, members] = await Promise.all([
				c.query(
					'SELECT id,name,source_type AS "sourceType",source_url AS "sourceUrl",license_label AS "licenseLabel",permitted_uses AS "permittedUses",export_allowed AS "exportAllowed",outreach_allowed AS "outreachAllowed",enabled,notes FROM research_sources WHERE tenant_id=$1 ORDER BY name',
					[t]
				),
				c.query(
					'SELECT id,title,criteria,source_ids AS "sourceIds",status,budget_cap_minor AS "budgetCapMinor",currency,assigned_to AS "assignedTo",due_at AS "dueAt",outcome,created_at AS "createdAt" FROM research_queue WHERE tenant_id=$1 ORDER BY created_at DESC',
					[t]
				),
				c.query(
					'SELECT prospect_id AS "prospectId",excluded,opted_out AS "optedOut",reason,updated_at AS "updatedAt" FROM prospect_research_controls WHERE tenant_id=$1',
					[t]
				),
				c.query('SELECT weights FROM research_preferences WHERE tenant_id=$1', [t]),
				c.query(
					"SELECT stage,count(*)::int AS count FROM prospects WHERE tenant_id=$1 AND COALESCE(data->>'mergedInto','')='' GROUP BY stage ORDER BY stage",
					[t]
				),
				c.query(
					'SELECT from_stage AS "from",to_stage AS "to",count(*)::int AS count FROM prospect_stage_events WHERE tenant_id=$1 GROUP BY from_stage,to_stage ORDER BY from_stage,to_stage',
					[t]
				),
				c.query(
					"SELECT u.id,u.display_name AS name,m.role FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.tenant_id=$1 AND m.status='active' AND u.disabled_at IS NULL ORDER BY u.display_name",
					[t]
				)
			]);
			return {
				sources: sources.rows,
				queue: queue.rows,
				controls: controls.rows,
				weights: pref.rows[0]?.weights || {
					affinity: 35,
					philanthropy: 25,
					connection: 20,
					recency: 10,
					geography: 10
				},
				funnel: funnel.rows,
				transitions: transitions.rows,
				members: members.rows
			};
		});
		return json(data, { headers: { 'cache-control': 'private, no-store' } });
	} catch (e) {
		return json(
			{ error: e instanceof Error ? e.message : 'Research controls unavailable.' },
			{ status: Number((e as any)?.status) || 422 }
		);
	}
}
export async function POST({ request, locals }) {
	try {
		const body = await request.json();
		const tenant = String(body.tenant || '');
		await authorizedWorkspace(locals.session, tenant, true);
		if (!env.DATABASE_URL)
			return json({ error: 'Research controls require the persistent database.' }, { status: 503 });
		const action = z
			.enum([
				'weights',
				'source',
				'source_update',
				'queue',
				'control',
				'queue_status',
				'review',
				'merge',
				'split',
				'stage'
			])
			.parse(body.action);
		const result = await scoped(locals.session, async (c: any, t: string) => {
			if (action === 'weights') {
				const weights = weightsSchema.parse(body.weights);
				await c.query(
					'INSERT INTO research_preferences(tenant_id,weights,updated_by) VALUES($1,$2,$3) ON CONFLICT(tenant_id) DO UPDATE SET weights=EXCLUDED.weights,updated_by=EXCLUDED.updated_by,updated_at=now()',
					[t, weights, locals.session!.userId]
				);
				return { weights };
			}
			if (action === 'source') {
				const v = sourceSchema.parse(body.source);
				if (v.sourceUrl && new URL(v.sourceUrl).protocol !== 'https:')
					throw Object.assign(new Error('Research source links must use HTTPS.'), { status: 422 });
				if (v.exportAllowed && !v.permittedUses.includes('export'))
					throw Object.assign(new Error('The recorded license does not permit export.'), {
						status: 422
					});
				if (v.outreachAllowed && !v.permittedUses.includes('outreach'))
					throw Object.assign(new Error('The recorded license does not permit outreach.'), {
						status: 422
					});
				const saved = await c.query(
					'INSERT INTO research_sources(tenant_id,name,source_type,source_url,license_label,permitted_uses,export_allowed,outreach_allowed,enabled,notes,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id,name,source_type AS "sourceType",source_url AS "sourceUrl",license_label AS "licenseLabel",permitted_uses AS "permittedUses",export_allowed AS "exportAllowed",outreach_allowed AS "outreachAllowed",enabled,notes',
					[
						t,
						v.name,
						v.sourceType,
						v.sourceUrl || null,
						v.licenseLabel,
						v.permittedUses,
						v.exportAllowed,
						v.outreachAllowed,
						v.enabled,
						v.notes,
						locals.session!.userId
					]
				);
				return { source: saved.rows[0] };
			}
			if (action === 'source_update') {
				const v = sourceUpdateSchema.parse(body.sourceUpdate);
				const saved = await c.query(
					'UPDATE research_sources SET enabled=$3,updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING id,enabled',
					[t, v.id, v.enabled]
				);
				if (!saved.rowCount)
					throw Object.assign(new Error('Research source not found.'), { status: 404 });
				await c.query(
					'INSERT INTO audit_log(tenant_id,actor_id,action,resource,record_id,details) VALUES($1,$2,$3,$4,$5,$6)',
					[
						t,
						locals.session!.userId,
						'research.source_enabled_changed',
						'research_sources',
						v.id,
						{ enabled: v.enabled }
					]
				);
				return { source: saved.rows[0] };
			}
			if (action === 'queue') {
				const v = queueSchema.parse(body.queue);
				const active = await c.query(
					"SELECT id FROM research_sources WHERE tenant_id=$1 AND id=ANY($2::uuid[]) AND enabled=true AND 'research'=ANY(permitted_uses)",
					[t, v.sourceIds]
				);
				if (active.rowCount !== new Set(v.sourceIds).size)
					throw Object.assign(
						new Error(
							'Every queued source must be enabled and permit research in this tenant’s catalog.'
						),
						{ status: 422 }
					);
				if (v.assignedTo) {
					const member = await c.query(
						"SELECT 1 FROM memberships WHERE tenant_id=$1 AND user_id=$2 AND status='active'",
						[t, v.assignedTo]
					);
					if (!member.rowCount)
						throw Object.assign(new Error('Choose an active tenant member for assignment.'), {
							status: 422
						});
				}
				const saved = await c.query(
					'INSERT INTO research_queue(tenant_id,title,criteria,source_ids,budget_cap_minor,currency,assigned_to,created_by,due_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id,title,criteria,source_ids AS "sourceIds",status,budget_cap_minor AS "budgetCapMinor",currency,assigned_to AS "assignedTo",due_at AS "dueAt",created_at AS "createdAt"',
					[
						t,
						v.title,
						v.criteria,
						v.sourceIds,
						v.budgetCapMinor,
						v.currency,
						v.assignedTo || null,
						locals.session!.userId,
						v.dueAt || null
					]
				);
				await c.query(
					'INSERT INTO audit_log(tenant_id,actor_id,action,resource,record_id,details) VALUES($1,$2,$3,$4,$5,$6)',
					[
						t,
						locals.session!.userId,
						'research.queue_created',
						'research_queue',
						saved.rows[0].id,
						{ sourceIds: v.sourceIds, budgetCapMinor: v.budgetCapMinor }
					]
				);
				return {
					item: saved.rows[0],
					message: 'Queued for staff research. No provider was contacted.'
				};
			}
			if (action === 'queue_status') {
				const v = queueStatusSchema.parse(body.queueStatus);
				const current = await c.query(
					'SELECT status FROM research_queue WHERE tenant_id=$1 AND id=$2 FOR UPDATE',
					[t, v.id]
				);
				if (!current.rowCount)
					throw Object.assign(new Error('Research queue task not found.'), { status: 404 });
				const allowed: Record<string, string[]> = {
					queued: ['in_progress', 'cancelled'],
					in_progress: ['ready_for_review', 'cancelled'],
					ready_for_review: ['in_progress', 'completed', 'cancelled'],
					completed: [],
					cancelled: []
				};
				if (!allowed[current.rows[0].status]?.includes(v.status))
					throw Object.assign(new Error('This queue task cannot move to that status.'), {
						status: 422
					});
				const saved = await c.query(
					`UPDATE research_queue SET status=$3,outcome=CASE WHEN $4<>'' THEN outcome || jsonb_build_object('latestNote',$4,'updatedAt',now()) ELSE outcome END,updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING id,status,outcome`,
					[t, v.id, v.status, v.outcome]
				);
				await c.query(
					'INSERT INTO audit_log(tenant_id,actor_id,action,resource,record_id,details) VALUES($1,$2,$3,$4,$5,$6)',
					[
						t,
						locals.session!.userId,
						'research.queue_status_changed',
						'research_queue',
						v.id,
						{ from: current.rows[0].status, to: v.status, outcome: v.outcome }
					]
				);
				return { item: saved.rows[0] };
			}
			if (action === 'stage') {
				const v = stageSchema.parse(body.stage);
				const current = await c.query(
					'SELECT id,stage,data FROM prospects WHERE tenant_id=$1 AND id=$2 FOR UPDATE',
					[t, v.prospectId]
				);
				if (!current.rowCount)
					throw Object.assign(new Error('Prospect not found.'), { status: 404 });
				const previous = String(current.rows[0].stage || 'discovered');
				if (previous === v.stage) return { ok: true };
				const order = [
					'discovered',
					'screened',
					'qualified',
					'assigned',
					'introduction_requested',
					'contacted',
					'meeting',
					'solicited',
					'committed',
					'donated',
					'stewarded'
				];
				if (v.stage !== 'rejected' && order.indexOf(v.stage) !== order.indexOf(previous) + 1)
					throw Object.assign(
						new Error('Prospect stages must advance one reviewed step at a time.'),
						{ status: 422 }
					);
				const data = { ...current.rows[0].data, stage: v.stage };
				await c.query(
					'UPDATE prospects SET stage=$3,data=$4,updated_at=now() WHERE tenant_id=$1 AND id=$2',
					[t, v.prospectId, v.stage, data]
				);
				await c.query(
					'INSERT INTO prospect_stage_events(tenant_id,prospect_id,from_stage,to_stage,reason,actor_id) VALUES($1,$2,$3,$4,$5,$6)',
					[t, v.prospectId, previous, v.stage, v.reason, locals.session!.userId]
				);
				await c.query(
					'INSERT INTO audit_log(tenant_id,actor_id,action,resource,record_id,details) VALUES($1,$2,$3,$4,$5,$6)',
					[
						t,
						locals.session!.userId,
						'prospect.stage_changed',
						'prospects',
						v.prospectId,
						{ from: previous, to: v.stage, reason: v.reason }
					]
				);
				return { stage: v.stage };
			}
			if (action === 'review') {
				const v = reviewSchema.parse(body.review);
				const current = await c.query(
					'SELECT stage,match_status,data FROM prospects WHERE tenant_id=$1 AND id=$2 FOR UPDATE',
					[t, v.prospectId]
				);
				if (!current.rowCount)
					throw Object.assign(new Error('Prospect not found.'), { status: 404 });
				const before = {
					stage: current.rows[0].stage,
					matchStatus: current.rows[0].match_status,
					data: current.rows[0].data
				};
				const nextStage = v.decision === 'accepted' ? 'screened' : 'rejected';
				const nextMatch = v.decision === 'accepted' ? 'likely' : 'rejected';
				await c.query(
					"UPDATE prospects SET stage=$3,match_status=$4,data=data||jsonb_build_object('reviewReason',$5,'reviewedAt',now()),updated_at=now() WHERE tenant_id=$1 AND id=$2",
					[t, v.prospectId, nextStage, nextMatch, v.reason]
				);
				await c.query(
					'INSERT INTO prospect_review_events(tenant_id,prospect_id,action,reason,actor_id,before_data,after_data) VALUES($1,$2,$3,$4,$5,$6,$7)',
					[
						t,
						v.prospectId,
						v.decision === 'accepted' ? 'accepted' : 'rejected',
						v.reason,
						locals.session!.userId,
						before,
						{ stage: nextStage, matchStatus: nextMatch }
					]
				);
				if (before.stage !== nextStage)
					await c.query(
						'INSERT INTO prospect_stage_events(tenant_id,prospect_id,from_stage,to_stage,reason,actor_id) VALUES($1,$2,$3,$4,$5,$6)',
						[t, v.prospectId, before.stage, nextStage, v.reason, locals.session!.userId]
					);
				await c.query(
					'INSERT INTO audit_log(tenant_id,actor_id,action,resource,record_id,details) VALUES($1,$2,$3,$4,$5,$6)',
					[
						t,
						locals.session!.userId,
						'prospect.reviewed',
						'prospects',
						v.prospectId,
						{ decision: v.decision, reason: v.reason }
					]
				);
				return { decision: v.decision };
			}
			if (action === 'merge') {
				const v = mergeSchema.parse(body.merge);
				if (v.primaryId === v.duplicateId)
					throw Object.assign(new Error('Choose two different prospect records.'), { status: 422 });
				const pair = await c.query(
					'SELECT id,stage,match_status,data FROM prospects WHERE tenant_id=$1 AND id=ANY($2::uuid[]) FOR UPDATE',
					[t, [v.primaryId, v.duplicateId]]
				);
				if (pair.rowCount !== 2)
					throw Object.assign(new Error('Both records must belong to this tenant.'), {
						status: 404
					});
				const duplicate = pair.rows.find((r: any) => r.id === v.duplicateId);
				if (duplicate.data?.mergedInto)
					throw Object.assign(new Error('This prospect is already merged.'), { status: 422 });
				const primary = pair.rows.find((r: any) => r.id === v.primaryId);
				const before = {
					stage: duplicate.stage,
					matchStatus: duplicate.match_status,
					data: duplicate.data
				};
				await c.query(
					"INSERT INTO prospect_evidence(tenant_id,prospect_id,source_name,source_url,evidence_type,confidence,observed_at,license,data,source_id) SELECT tenant_id,$3,source_name,source_url,evidence_type,confidence,observed_at,license,data||jsonb_build_object('mergedFromProspectId',$2),source_id FROM prospect_evidence WHERE tenant_id=$1 AND prospect_id=$2",
					[t, v.duplicateId, v.primaryId]
				);
				await c.query(
					"UPDATE prospects SET stage='rejected',match_status='confirmed',data=data||jsonb_build_object('mergedInto',$3),updated_at=now() WHERE tenant_id=$1 AND id=$2",
					[t, v.duplicateId, v.primaryId]
				);
				await c.query(
					"INSERT INTO prospect_review_events(tenant_id,prospect_id,action,reason,related_prospect_id,actor_id,before_data,after_data) VALUES($1,$2,'merged',$3,$4,$5,$6,$7)",
					[
						t,
						v.duplicateId,
						v.reason,
						v.primaryId,
						locals.session!.userId,
						before,
						{ mergedInto: v.primaryId, canonicalName: primary.data?.name || '' }
					]
				);
				await c.query(
					'INSERT INTO audit_log(tenant_id,actor_id,action,resource,record_id,details) VALUES($1,$2,$3,$4,$5,$6)',
					[
						t,
						locals.session!.userId,
						'prospect.merged',
						'prospects',
						v.duplicateId,
						{ primaryId: v.primaryId, reason: v.reason }
					]
				);
				return { merged: true, primaryId: v.primaryId };
			}
			if (action === 'split') {
				const v = splitSchema.parse(body.split);
				const merge = await c.query(
					"SELECT related_prospect_id,before_data FROM prospect_review_events WHERE tenant_id=$1 AND prospect_id=$2 AND action='merged' ORDER BY created_at DESC LIMIT 1",
					[t, v.prospectId]
				);
				if (!merge.rowCount)
					throw Object.assign(new Error('No reversible prospect merge was found.'), {
						status: 404
					});
				const before = merge.rows[0].before_data;
				const primaryId = merge.rows[0].related_prospect_id;
				const latestSplit = await c.query(
					"SELECT 1 FROM prospect_review_events WHERE tenant_id=$1 AND prospect_id=$2 AND action='split' AND created_at>(SELECT created_at FROM prospect_review_events WHERE tenant_id=$1 AND prospect_id=$2 AND action='merged' ORDER BY created_at DESC LIMIT 1)",
					[t, v.prospectId]
				);
				if (latestSplit.rowCount)
					throw Object.assign(new Error('This merged record was already split.'), { status: 422 });
				await c.query(
					"UPDATE prospects SET stage=$3,match_status=$4,data=(data-'mergedInto')||jsonb_build_object('splitReason',$5,'splitAt',now()),updated_at=now() WHERE tenant_id=$1 AND id=$2",
					[
						t,
						v.prospectId,
						before.stage || 'discovered',
						before.matchStatus || 'possible',
						v.reason
					]
				);
				await c.query(
					"UPDATE prospect_evidence SET data=data||jsonb_build_object('detachedAfterSplitAt',now()) WHERE tenant_id=$1 AND prospect_id=$2 AND data->>'mergedFromProspectId'=$3",
					[t, primaryId, v.prospectId]
				);
				await c.query(
					"INSERT INTO prospect_review_events(tenant_id,prospect_id,action,reason,related_prospect_id,actor_id,before_data,after_data) VALUES($1,$2,'split',$3,$4,$5,$6,$7)",
					[
						t,
						v.prospectId,
						v.reason,
						primaryId,
						locals.session!.userId,
						{ mergedInto: primaryId },
						{ stage: before.stage || 'discovered' }
					]
				);
				await c.query(
					'INSERT INTO prospect_stage_events(tenant_id,prospect_id,from_stage,to_stage,reason,actor_id) VALUES($1,$2,$3,$4,$5,$6)',
					[
						t,
						v.prospectId,
						'rejected',
						before.stage || 'discovered',
						v.reason,
						locals.session!.userId
					]
				);
				await c.query(
					'INSERT INTO audit_log(tenant_id,actor_id,action,resource,record_id,details) VALUES($1,$2,$3,$4,$5,$6)',
					[
						t,
						locals.session!.userId,
						'prospect.split',
						'prospects',
						v.prospectId,
						{ primaryId, reason: v.reason }
					]
				);
				return { split: true, prospectId: v.prospectId };
			}
			const v = controlSchema.parse(body.control);
			const exists = await c.query('SELECT 1 FROM prospects WHERE tenant_id=$1 AND id=$2', [
				t,
				v.prospectId
			]);
			if (!exists.rowCount) throw Object.assign(new Error('Prospect not found.'), { status: 404 });
			const saved = await c.query(
				'INSERT INTO prospect_research_controls(tenant_id,prospect_id,excluded,opted_out,reason,updated_by) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(tenant_id,prospect_id) DO UPDATE SET excluded=EXCLUDED.excluded,opted_out=EXCLUDED.opted_out,reason=EXCLUDED.reason,updated_by=EXCLUDED.updated_by,updated_at=now() RETURNING prospect_id AS "prospectId",excluded,opted_out AS "optedOut",reason,updated_at AS "updatedAt"',
				[t, v.prospectId, v.excluded, v.optedOut, v.reason, locals.session!.userId]
			);
			await c.query(
				'INSERT INTO audit_log(tenant_id,actor_id,action,resource,record_id,details) VALUES($1,$2,$3,$4,$5,$6)',
				[
					t,
					locals.session!.userId,
					'prospect.research_control_changed',
					'prospects',
					v.prospectId,
					{ excluded: v.excluded, optedOut: v.optedOut, reason: v.reason }
				]
			);
			return { control: saved.rows[0] };
		});
		return json(
			{ ok: true, ...result },
			{
				status: action === 'source' || action === 'queue' ? 201 : 200,
				headers: { 'cache-control': 'private, no-store' }
			}
		);
	} catch (e) {
		if ((e as any)?.name === 'ZodError')
			return json(
				{ error: 'Research controls validation failed.', details: (e as any).issues },
				{ status: 422 }
			);
		return json(
			{ error: e instanceof Error ? e.message : 'Research controls could not be saved.' },
			{ status: Number((e as any)?.status) || 422 }
		);
	}
}
