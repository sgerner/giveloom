import { afterAll, describe, expect, it } from 'vitest';
import { createOwnerAccount, getPool, mutatePostgres } from '../src/lib/server/database';
import { GET as evidenceGet } from '../src/routes/api/v1/relationships/evidence/+server';
import { POST as pathsPost } from '../src/routes/api/v1/relationships/paths/+server';

const enabled = !!process.env.DATABASE_URL && process.env.RUN_POSTGRES_MUTATION_TESTS === 'true';
afterAll(async () => {
	if (enabled) await getPool().end();
});

describe('scalable relationship explorer', () => {
	it.skipIf(!enabled)(
		'pages evidence and searches tenant nodes without loading the full workspace',
		async () => {
			const suffix = crypto.randomUUID().slice(0, 8),
				slug = `graph-page-${suffix}`;
			const account = await createOwnerAccount({
				email: `${slug}@example.test`,
				name: 'Graph Owner',
				passwordHash: 'fixture',
				organizationName: 'Graph tests',
				slug,
				sessionExpiresAt: new Date(Date.now() + 3_600_000),
				testOnlyVerifiedFixture: true
			});
			const session = { userId: account.userId, tenantSlug: slug, role: 'owner', demo: false };
			const nodes = await Promise.all(
				[1, 2, 3].map(
					(i) =>
						mutatePostgres(
							slug,
							account.userId,
							'contacts',
							{ name: `Graph Node ${i}` },
							'create'
						) as Promise<any>
				)
			);
			const client = await getPool().connect();
			try {
				await client.query('BEGIN');
				await client.query("SELECT set_config('app.tenant_id',$1,true)", [account.tenant.id]);
				for (const [index, node] of nodes.entries())
					await client.query(
						"INSERT INTO graph_nodes(tenant_id,entity_id,node_type,display_name,source_resource,privacy_scope) VALUES($1,$2,'person',$3,'contacts','tenant')",
						[account.tenant.id, node.id, `Graph Node ${index + 1}`]
					);
				for (const [from, to] of [
					[nodes[0], nodes[1]],
					[nodes[1], nodes[2]]
				])
					await client.query(
						"INSERT INTO graph_edges(tenant_id,from_id,to_id,edge_type,evidence_type,provenance_label,confidence,privacy_scope,verification_status,observed_at) VALUES($1,$2,$3,'known_by','tenant_note','Documented staff connection','high','tenant','verified',now())",
						[account.tenant.id, from.id, to.id]
					);
				await client.query('COMMIT');
			} catch (error) {
				await client.query('ROLLBACK');
				throw error;
			} finally {
				client.release();
			}
			const firstResponse = await evidenceGet({
				url: new URL(`http://localhost/api/v1/relationships/evidence?tenant=${slug}&limit=1`),
				locals: { session }
			} as any);
			const first = await firstResponse.json();
			expect(firstResponse.status).toBe(200);
			expect(first.edges).toHaveLength(1);
			expect(first.nextCursor).toBeTruthy();
			expect(first.nodes.some((node: any) => node.name === 'Graph Node 3')).toBe(true);
			const secondResponse = await evidenceGet({
				url: new URL(
					`http://localhost/api/v1/relationships/evidence?tenant=${slug}&limit=1&cursor=${encodeURIComponent(first.nextCursor)}`
				),
				locals: { session }
			} as any);
			const second = await secondResponse.json();
			expect(
				second.edges,
				JSON.stringify({ status: secondResponse.status, cursor: first.nextCursor, result: second })
			).toHaveLength(1);
			expect(second.edges[0].id).not.toBe(first.edges[0].id);
			const searchedResponse = await evidenceGet({
				url: new URL(
					`http://localhost/api/v1/relationships/evidence?tenant=${slug}&limit=1&nodeQuery=Graph%20Node%203`
				),
				locals: { session }
			} as any);
			const searched = await searchedResponse.json();
			expect(searched.nodes).toContainEqual(
				expect.objectContaining({
					id: nodes[2].id,
					name: 'Graph Node 3',
					sourceResource: 'contacts'
				})
			);
			const pathResponse = await pathsPost({
				request: {
					json: async () => ({ tenant: slug, fromId: nodes[0].id, toId: nodes[2].id, depth: 2 })
				},
				locals: { session }
			} as any);
			const pathResult = await pathResponse.json();
			expect(pathResponse.status).toBe(200);
			expect(pathResult.paths).toHaveLength(1);
			expect(pathResult.paths[0]).toHaveLength(2);
		}
	);
});
