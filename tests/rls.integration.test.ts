import { afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';

const connection = process.env.DATABASE_URL;
const pool = connection ? new Pool({ connectionString: connection, max: 2 }) : null;
afterAll(async () => {
	await pool?.end();
});

describe('PostgreSQL tenant RLS integration', () => {
	it.skipIf(!pool)(
		'scopes graph evidence and requires documented donor consent in the database',
		async (ctx) => {
			const client = await pool!.connect();
			try {
				const identity = await client.query(
					'SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user'
				);
				if (identity.rows[0]?.rolsuper || identity.rows[0]?.rolbypassrls)
					ctx.skip('Use the non-superuser application connection to exercise RLS.');
				const tables = await client.query(
					"SELECT to_regclass('graph_edges') AS edges,to_regclass('introduction_events') AS intros"
				);
				if (!tables.rows[0]?.edges || !tables.rows[0]?.intros)
					ctx.skip('Run database migrations before intelligence checks.');
				const tenants = await client.query('SELECT id FROM tenants ORDER BY slug LIMIT 2');
				if (tenants.rows.length < 2)
					ctx.skip('Seed two tenants before intelligence isolation checks.');
				const a = tenants.rows[0].id,
					b = tenants.rows[1].id;
				await client.query('BEGIN');
				await client.query("SELECT set_config('app.tenant_id',$1,true)", [a]);
				const edgeId = crypto.randomUUID();
				await client.query(
					"INSERT INTO graph_edges(tenant_id,id,from_id,to_id,edge_type,evidence_type,provenance_label,confidence) VALUES($1,$2,$3,$4,'trustee_of','public_filing','IRS filing','medium')",
					[a, edgeId, crypto.randomUUID(), crypto.randomUUID()]
				);
				expect(
					(await client.query('SELECT id FROM graph_edges WHERE tenant_id=$1', [b])).rowCount
				).toBe(0);
				await client.query('SAVEPOINT missing_consent');
				await expect(
					client.query(
						"INSERT INTO introduction_events(tenant_id,introduction_id,from_stage,to_stage,consent_status) VALUES($1,$2,'donor_asked','donor_consented','unsure')",
						[a, crypto.randomUUID()]
					)
				).rejects.toThrow();
				await client.query('ROLLBACK TO SAVEPOINT missing_consent');
				await client.query(
					"INSERT INTO introduction_events(tenant_id,introduction_id,from_stage,to_stage,consent_status,consent_evidence) VALUES($1,$2,'donor_asked','donor_consented','yes','Donor confirmed by phone')",
					[a, crypto.randomUUID()]
				);
				await client.query('SAVEPOINT foreign_graph_edge');
				await expect(
					client.query(
						"INSERT INTO graph_edges(tenant_id,from_id,to_id,edge_type,evidence_type,provenance_label,confidence) VALUES($1,$2,$3,'affiliation','public_filing','foreign tenant attempt','low')",
						[b, crypto.randomUUID(), crypto.randomUUID()]
					)
				).rejects.toThrow();
				await client.query('ROLLBACK TO SAVEPOINT foreign_graph_edge');
				await client.query('ROLLBACK');
			} finally {
				client.release();
			}
		}
	);
	it.skipIf(!pool)('does not return or accept records belonging to another tenant', async (ctx) => {
		const client = await pool!.connect();
		try {
			const identity = await client.query(
				'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname=current_user'
			);
			if (identity.rows[0]?.rolsuper || identity.rows[0]?.rolbypassrls)
				ctx.skip('Use a non-superuser application DATABASE_URL to exercise RLS policies.');
			const schema = await client.query(
				"SELECT to_regclass('tenants') AS tenants, to_regclass('contacts') AS contacts"
			);
			if (!schema.rows[0]?.tenants || !schema.rows[0]?.contacts)
				ctx.skip('Run database migrations before the RLS integration test.');
			const tenants = await client.query('SELECT id FROM tenants ORDER BY slug LIMIT 2');
			if (tenants.rows.length < 2)
				ctx.skip('Seed at least two tenants before running RLS integration tests.');
			const tenantA = tenants.rows[0].id as string;
			const tenantB = tenants.rows[1].id as string;
			await client.query('BEGIN');
			await client.query("SELECT set_config('app.tenant_id',$1,true)", [tenantA]);
			const hidden = await client.query('SELECT id FROM contacts WHERE tenant_id=$1 LIMIT 1', [
				tenantB
			]);
			expect(hidden.rowCount).toBe(0);
			await client.query('SAVEPOINT cross_tenant_write');
			await expect(
				client.query('INSERT INTO contacts(tenant_id,name) VALUES($1,$2)', [
					tenantB,
					'RLS negative test'
				])
			).rejects.toThrow();
			await client.query('ROLLBACK TO SAVEPOINT cross_tenant_write');
			const ownedA = await client.query('SELECT id FROM contacts WHERE tenant_id=$1 LIMIT 1', [
				tenantA
			]);
			await client.query("SELECT set_config('app.tenant_id',$1,true)", [tenantB]);
			const ownedB = await client.query('SELECT id FROM contacts WHERE tenant_id=$1 LIMIT 1', [
				tenantB
			]);
			await client.query("SELECT set_config('app.tenant_id',$1,true)", [tenantA]);
			if (ownedA.rows[0]?.id && ownedB.rows[0]?.id) {
				await client.query('SAVEPOINT foreign_gift_reference');
				await expect(
					client.query(
						"INSERT INTO gifts(tenant_id,contact_id,amount_minor,currency) VALUES($1,$2,100,'USD')",
						[tenantA, ownedB.rows[0].id]
					)
				).rejects.toThrow();
				await client.query('ROLLBACK TO SAVEPOINT foreign_gift_reference');
			}
			const authTables = await client.query(
				"SELECT to_regclass('users') AS users,to_regclass('auth_sessions') AS sessions"
			);
			if (authTables.rows[0]?.users && authTables.rows[0]?.sessions) {
				const memberA = await client.query(
					"SELECT user_id FROM memberships WHERE tenant_id=$1 AND status='active' LIMIT 1",
					[tenantA]
				);
				await client.query("SELECT set_config('app.tenant_id',$1,true)", [tenantB]);
				const memberB = await client.query(
					"SELECT user_id FROM memberships WHERE tenant_id=$1 AND status='active' LIMIT 1",
					[tenantB]
				);
				if (memberA.rows[0]?.user_id && memberB.rows[0]?.user_id) {
					await client.query("SELECT set_config('app.tenant_id',$1,true)", [tenantB]);
					const sessionId = crypto.randomUUID();
					await client.query(
						"INSERT INTO auth_sessions(id,tenant_id,user_id,session_version,expires_at) SELECT $1,$2,u.id,u.session_version,now()+interval '1 hour' FROM users u WHERE u.id=$3",
						[sessionId, tenantB, memberB.rows[0].user_id]
					);
					await client.query("SELECT set_config('app.tenant_id',$1,true)", [tenantA]);
					const hiddenUser = await client.query('SELECT id FROM users WHERE id=$1', [
						memberB.rows[0].user_id
					]);
					const hiddenSession = await client.query('SELECT id FROM auth_sessions WHERE id=$1', [
						sessionId
					]);
					expect(hiddenUser.rowCount).toBe(0);
					expect(hiddenSession.rowCount).toBe(0);
				}
			}
			await client.query('ROLLBACK');
		} finally {
			client.release();
		}
	});
});
