import { it, expect, afterAll } from 'vitest';
import { createOwnerAccount, getPool, mutatePostgres } from '../src/lib/server/database';
import { givingCommand } from '../src/lib/server/giving';
import { reportingInsights } from '../src/lib/server/reporting';
import { tenantTransaction } from '../src/lib/server/tenant-service';
const enabled = !!process.env.DATABASE_URL && process.env.RUN_POSTGRES_MUTATION_TESTS === 'true';
afterAll(async () => {
	if (enabled) await getPool().end();
});
it.skipIf(!enabled)(
	'executes real reporting queries with tenant-scoped ledger and known fees',
	async () => {
		const n = crypto.randomUUID().slice(0, 8),
			slug = 'report-' + n;
		const a = await createOwnerAccount({
			email: slug + '@example.test',
			name: 'Reports owner',
			passwordHash: 'fixture',
			organizationName: 'Reporting tests',
			slug,
			sessionExpiresAt: new Date(Date.now() + 3600000),
			testOnlyVerifiedFixture: true
		});
		const session = { userId: a.userId, tenantSlug: slug, role: 'owner', demo: false };
		const c = (await mutatePostgres(
			slug,
			a.userId,
			'contacts',
			{ name: 'Report donor' },
			'create'
		)) as any;
		await givingCommand(session, {
			action: 'record',
			requestKey: crypto.randomUUID(),
			contactId: c.id,
			amountMinor: 10000,
			currency: 'USD',
			kind: 'one_time',
			method: 'cash',
			feeMinor: 100
		});
		const r = await reportingInsights(session, { currency: 'USD' });
		expect(r.ledger.grossMinor).toBe(10000);
		expect(r.netAfterKnownFeesMinor).toBe(9900);
		expect(r.ledger.giftCount).toBe(1);
		expect(r.recurring?.active).toBe(0);
		await expect(
			reportingInsights({ ...session, userId: crypto.randomUUID() }, {})
		).rejects.toMatchObject({ status: 403 });
	}
);

it.skipIf(!enabled)(
	'applies campaign and owner filters to associated recurring and pledge pipelines, and excludes unsupported proposal scope',
	async () => {
		const n = crypto.randomUUID().slice(0, 8),
			slug = 'report-scope-' + n;
		const a = await createOwnerAccount({
			email: slug + '@example.test',
			name: 'Report scope owner',
			passwordHash: 'fixture',
			organizationName: 'Reporting scope tests',
			slug,
			sessionExpiresAt: new Date(Date.now() + 3600000),
			testOnlyVerifiedFixture: true
		});
		const session = { userId: a.userId, tenantSlug: slug, role: 'owner', demo: false };
		const primary = (await mutatePostgres(
			slug,
			a.userId,
			'contacts',
			{ name: 'Primary donor' },
			'create'
		)) as any;
		const other = (await mutatePostgres(
			slug,
			a.userId,
			'contacts',
			{ name: 'Other donor' },
			'create'
		)) as any;
		await tenantTransaction(session, ['owner'], async (client, t) => {
			const fundA = crypto.randomUUID(),
				fundB = crypto.randomUUID();
			const campaignA = crypto.randomUUID(),
				campaignB = crypto.randomUUID();
			await client.query(
				'INSERT INTO funds(tenant_id,id,name,slug) VALUES($1,$2,$3,$4),($1,$5,$6,$7)',
				[t.id, fundA, 'Scope fund A', 'scope-a-' + n, fundB, 'Scope fund B', 'scope-b-' + n]
			);
			await client.query(
				'INSERT INTO campaigns(tenant_id,id,name,fund_id) VALUES($1,$2,$3,$4),($1,$5,$6,$7)',
				[t.id, campaignA, 'Scope campaign A', fundA, campaignB, 'Scope campaign B', fundB]
			);
			await client.query(
				"UPDATE contacts SET data=jsonb_set(coalesce(data,'{}'::jsonb),'{ownerId}',to_jsonb($3::text),true) WHERE tenant_id=$1 AND id=$2",
				[t.id, primary.id, a.userId]
			);
			await client.query(
				"UPDATE contacts SET data=jsonb_set(coalesce(data,'{}'::jsonb),'{ownerId}',to_jsonb($3::text),true) WHERE tenant_id=$1 AND id=$2",
				[t.id, other.id, crypto.randomUUID()]
			);
			await client.query(
				"INSERT INTO gifts(tenant_id,contact_id,campaign_id,fund_id,amount_minor,currency,kind,status) VALUES($1,$2,$3,$4,10000,'USD','one_time','recorded'),($1,$5,$6,$7,90000,'USD','one_time','recorded')",
				[t.id, primary.id, campaignA, fundA, other.id, campaignB, fundB]
			);
			for (const [contactId, campaignId, fundId, amount, suffix] of [
				[primary.id, campaignA, fundA, 2000, 'a'],
				[other.id, campaignB, fundB, 8000, 'b']
			] as const) {
				const h = crypto.randomUUID().replaceAll('-', '').padEnd(64, '0');
				await client.query(
					"INSERT INTO donation_intents(tenant_id,contact_id,campaign_id,fund_id,stripe_account_id,request_key_hash,request_fingerprint,amount_minor,currency,frequency,status,donor_name,donor_email) VALUES($1,$2,$3,$4,'acct_test',$5,$6,$7,'USD','monthly','active','Scope donor',$8)",
					[t.id, contactId, campaignId, fundId, h, h, amount, suffix + '-' + slug + '@example.test']
				);
				await client.query(
					"INSERT INTO pledges(tenant_id,contact_id,campaign_id,amount_minor,currency,status) VALUES($1,$2,$3,$4,'USD','active')",
					[t.id, contactId, campaignId, amount * 2]
				);
			}
			await client.query(
				"INSERT INTO proposals(tenant_id,contact_id,owner_id,title,stage,ask_minor,currency) VALUES($1,$2,$3,'Primary proposal','submitted',30000,'USD'),($1,$4,NULL,'Other proposal','submitted',70000,'USD')",
				[t.id, primary.id, a.userId, other.id]
			);
		});
		const r = await reportingInsights(session, {
			currency: 'USD',
			campaignId: await tenantTransaction(
				session,
				['owner'],
				async (client, t) =>
					(
						await client.query(
							"SELECT id FROM campaigns WHERE tenant_id=$1 AND name='Scope campaign A'",
							[t.id]
						)
					).rows[0].id
			),
			ownerId: a.userId
		});
		expect(r.ledger.grossMinor).toBe(10000);
		expect(r.recurring?.mrrEquivalentMinor).toBe(2000);
		expect(r.pledgePipelineMinor).toBe(4000);
		expect(r.majorGiftPipelineMinor).toBeNull();
		expect(r.excludedMetrics).toContain('Major-gift proposal pipeline');
	}
);
