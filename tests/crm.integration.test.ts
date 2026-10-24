import { describe, it, expect, afterAll } from 'vitest';
import {
	createOwnerAccount,
	getPool,
	mutatePostgres,
	workspaceFromPostgres
} from '../src/lib/server/database';
import {
	crmCommand,
	crmSnapshot,
	contactPage,
	contactDetail,
	importReviewed,
	normalizeMethod,
	duplicateCandidates,
	contactTimeline
} from '../src/lib/server/crm';
import { givingSnapshot } from '../src/lib/server/giving';
const enabled = !!process.env.DATABASE_URL && process.env.RUN_POSTGRES_MUTATION_TESTS === 'true';
afterAll(async () => {
	if (enabled) await getPool().end();
});
describe('CRM documented details and import lifecycle', () => {
	it('normalizes phone/email without guessing an international country', () => {
		expect(normalizeMethod('email', ' X@Example.Test ')).toBe('x@example.test');
		expect(normalizeMethod('phone', '+1 (602) 555-0101')).toBe('+16025550101');
		expect(() => normalizeMethod('phone', 'abc')).toThrow();
	});
	it.skipIf(!enabled)(
		'enforces typed custom fields, documents consent and suppresses withdrawals',
		async () => {
			const n = crypto.randomUUID().slice(0, 8),
				slug = 'crm-' + n;
			const a = await createOwnerAccount({
				email: 'crm-' + n + '@example.test',
				name: 'CRM Owner',
				passwordHash: 'fixture',
				organizationName: 'CRM tests',
				slug,
				sessionExpiresAt: new Date(Date.now() + 3600000),
				testOnlyVerifiedFixture: true
			});
			const session = { userId: a.userId, tenantSlug: slug, role: 'owner', demo: false };
			const c = (await mutatePostgres(
				slug,
				a.userId,
				'contacts',
				{ name: 'CRM Donor', email: 'donor-' + n + '@example.test' },
				'create'
			)) as any;
			const other = (await mutatePostgres(
				slug,
				a.userId,
				'contacts',
				{ name: 'Other Donor' },
				'create'
			)) as any;
			await crmCommand(session, {
				action: 'method',
				contactId: c.id,
				kind: 'phone',
				value: '+16025550101',
				preferred: true
			});
			await crmCommand(session, {
				action: 'method',
				contactId: other.id,
				kind: 'phone',
				value: '+1 (602) 555-0101'
			});
			expect((await duplicateCandidates(session)).some((d) => d.reason === 'phone')).toBe(true);
			const field = await crmCommand(session, {
				action: 'field',
				name: 'Years supporting',
				kind: 'number',
				choices: [],
				sensitive: false,
				required: false
			});
			await expect(
				crmCommand(session, {
					action: 'value',
					contactId: c.id,
					fieldId: field.id,
					value: 'not a number'
				})
			).rejects.toThrow();
			await crmCommand(session, { action: 'value', contactId: c.id, fieldId: field.id, value: 3 });
			await crmCommand(session, {
				action: 'consent',
				contactId: c.id,
				channel: 'email',
				purpose: 'marketing',
				status: 'granted',
				source: 'Signed supporter form'
			});
			await crmCommand(session, {
				action: 'consent',
				contactId: c.id,
				channel: 'email',
				purpose: 'marketing',
				status: 'withdrawn',
				source: 'Donor telephone request'
			});
			const snapshot = await crmSnapshot(session, c.id);
			expect(snapshot.consents).toHaveLength(2);
			expect(snapshot.values[0].value).toBe(3);
			expect(snapshot.methods.find((m: any) => m.kind === 'phone').value).toBe('+16025550101');
			const timeline = await contactTimeline(session, c.id, { kind: 'consent', limit: 1 });
			expect(timeline.items).toHaveLength(1);
			expect(timeline.nextCursor).toBeTruthy();
			expect(
				(await contactTimeline(session, c.id, { kind: 'consent', cursor: timeline.nextCursor! }))
					.items
			).toHaveLength(1);
			const client = await getPool().connect();
			try {
				await client.query('BEGIN');
				await client.query("SELECT set_config('app.tenant_id',$1,true)", [a.tenant.id]);
				expect(
					(
						await client.query('SELECT email FROM email_suppressions WHERE tenant_id=$1', [
							a.tenant.id
						])
					).rowCount
				).toBe(1);
				await client.query('ROLLBACK');
			} finally {
				client.release();
			}
			await expect(
				crmCommand(session, {
					action: 'method',
					contactId: crypto.randomUUID(),
					kind: 'email',
					value: 'outside@example.test'
				})
			).rejects.toMatchObject({ status: 404 });
		}
	);
	it.skipIf(!enabled)(
		'maps arbitrary CSV headers, cursor-paginates and safely rolls back an unchanged import',
		async () => {
			const n = crypto.randomUUID().slice(0, 8),
				slug = 'imports-' + n,
				a = await createOwnerAccount({
					email: 'imports-' + n + '@example.test',
					name: 'Import Owner',
					passwordHash: 'fixture',
					organizationName: 'Import tests',
					slug,
					sessionExpiresAt: new Date(Date.now() + 3600000),
					testOnlyVerifiedFixture: true
				});
			const session = { userId: a.userId, tenantSlug: slug, role: 'owner', demo: false };
			const csv =
				'Full Name,Email Address\nA Person,a-' +
				n +
				'@example.test\nB Person,b-' +
				n +
				'@example.test\nC Person,c-' +
				n +
				'@example.test';
			const mapping = { name: 'Full Name', email: 'Email Address' };
			expect((await importReviewed(session, csv, true, mapping)).preview.createCount).toBe(3);
			const imported = (await importReviewed(session, csv, false, mapping)) as any;
			expect(imported.imported).toBe(3);
			const p1 = await contactPage(session, { limit: 2 });
			expect(p1.items).toHaveLength(2);
			expect(p1.nextCursor).toBeTruthy();
			const p2 = await contactPage(session, { limit: 2, cursor: p1.nextCursor! });
			expect(p2.items).toHaveLength(1);
			expect(p2.items[0].id).not.toBe(p1.items[0].id);
			expect(
				await crmCommand(session, {
					action: 'rollback_import',
					batchId: imported.batchId,
					confirmed: true
				})
			).toMatchObject({ archived: 3 });
			expect((await contactPage(session, {})).total).toBe(0);
		}
	);
	it.skipIf(!enabled)(
		'bounds compact workspace payloads and preserves exact metrics with 100k contacts',
		async () => {
			const n = crypto.randomUUID().slice(0, 8),
				slug = 'scale-' + n,
				a = await createOwnerAccount({
					email: 'scale-' + n + '@example.test',
					name: 'Scale Owner',
					passwordHash: 'fixture',
					organizationName: 'Scale tests',
					slug,
					sessionExpiresAt: new Date(Date.now() + 3600000),
					testOnlyVerifiedFixture: true
				});
			const session = { userId: a.userId, tenantSlug: slug, role: 'owner', demo: false };
			const client = await getPool().connect();
			try {
				await client.query('BEGIN');
				await client.query("SELECT set_config('app.tenant_id',$1,true)", [a.tenant.id]);
				await client.query(
					"INSERT INTO contacts(tenant_id,name,email,stage,tags,data) SELECT $1,'Scale Contact '||lpad(i::text,6,'0'),'scale-'||$2||'-'||i||'@example.test','new',ARRAY[]::text[],'{}'::jsonb FROM generate_series(1,100000) i",
					[a.tenant.id, n]
				);
				await client.query(
					"INSERT INTO gifts(tenant_id,contact_id,amount_minor,currency,kind,status,occurred_at) SELECT $1,id,12500,'USD','one_time','recorded',now() FROM contacts WHERE tenant_id=$1 ORDER BY name LIMIT 1",
					[a.tenant.id]
				);
				await client.query('COMMIT');
			} catch (error) {
				await client.query('ROLLBACK');
				throw error;
			} finally {
				client.release();
			}
			const compact = await workspaceFromPostgres(slug, a.userId, 'owner', { compact: true });
			expect(compact?.contacts).toHaveLength(200);
			expect(compact?.gifts).toHaveLength(0);
			expect(compact?.overview).toMatchObject({
				bounded: true,
				contactCount: 100000,
				giftEventCount: 1,
				grossMinor: 12500
			});
			expect(compact?.overview?.byMonth.reduce((sum, row) => sum + row.amountMinor, 0)).toBe(12500);
			expect(Buffer.byteLength(JSON.stringify(compact))).toBeLessThan(350_000);
			const first = await contactPage(session, { limit: 25 });
			expect(first.items).toHaveLength(25);
			expect(first.total).toBe(100000);
			expect(first.nextCursor).toBeTruthy();
			const second = await contactPage(session, { limit: 25, cursor: first.nextCursor! });
			expect(second.items).toHaveLength(25);
			expect(new Set([...first.items, ...second.items].map((row: any) => row.id)).size).toBe(50);
		}
	);
	it.skipIf(!enabled)(
		'returns canonical contact details with merged aliases and lifetime giving',
		async () => {
			const n = crypto.randomUUID().slice(0, 8),
				slug = 'detail-' + n,
				a = await createOwnerAccount({
					email: 'detail-' + n + '@example.test',
					name: 'Detail Owner',
					passwordHash: 'fixture',
					organizationName: 'Detail tests',
					slug,
					sessionExpiresAt: new Date(Date.now() + 3600000),
					testOnlyVerifiedFixture: true
				});
			const session = { userId: a.userId, tenantSlug: slug, role: 'owner', demo: false };
			const source = (await mutatePostgres(
				slug,
				a.userId,
				'contacts',
				{ name: 'Merged Supporter', email: 'source-' + n + '@example.test' },
				'create'
			)) as any;
			const target = (await mutatePostgres(
				slug,
				a.userId,
				'contacts',
				{ name: 'Canonical Supporter', email: 'target-' + n + '@example.test' },
				'create'
			)) as any;
			await mutatePostgres(
				slug,
				a.userId,
				'gifts',
				{
					contactId: source.id,
					amountMinor: 27500,
					currency: 'USD',
					kind: 'one_time',
					status: 'recorded'
				},
				'create'
			);
			const { mergePostgresContacts } = await import('../src/lib/server/database');
			await mergePostgresContacts(slug, a.userId, source.id, target.id);
			const detail = await contactDetail(session, target.id);
			expect(detail.contact.name).toBe('Canonical Supporter');
			expect(detail.aliases).toContainEqual({ id: source.id, name: 'Merged Supporter' });
			expect(detail.givingByCurrency).toContainEqual(
				expect.objectContaining({ currency: 'USD', grossMinor: 27500, giftCount: 1 })
			);
		}
	);
	it.skipIf(!enabled)(
		'pages giving history while keeping exact currency summaries and recurring commitments',
		async () => {
			const n = crypto.randomUUID().slice(0, 8),
				slug = 'giving-scale-' + n,
				a = await createOwnerAccount({
					email: 'giving-scale-' + n + '@example.test',
					name: 'Giving Owner',
					passwordHash: 'fixture',
					organizationName: 'Giving scale tests',
					slug,
					sessionExpiresAt: new Date(Date.now() + 3600000),
					testOnlyVerifiedFixture: true
				});
			const session = { userId: a.userId, tenantSlug: slug, role: 'owner', demo: false };
			const contact = (await mutatePostgres(
				slug,
				a.userId,
				'contacts',
				{ name: 'Ledger Donor' },
				'create'
			)) as any;
			const client = await getPool().connect();
			let expectedContact = '';
			try {
				await client.query('BEGIN');
				await client.query("SELECT set_config('app.tenant_id',$1,true)", [a.tenant.id]);
				expectedContact = contact.id;
				await client.query(
					"INSERT INTO gifts(tenant_id,contact_id,amount_minor,currency,kind,status,occurred_at) SELECT $1,$2,10000,'USD','one_time','recorded',now()-i*interval '1 second' FROM generate_series(1,120) i",
					[a.tenant.id, contact.id]
				);
				const target = await client.query(
					'SELECT id FROM gifts WHERE tenant_id=$1 ORDER BY occurred_at ASC LIMIT 1',
					[a.tenant.id]
				);
				await client.query(
					"INSERT INTO gifts(tenant_id,contact_id,amount_minor,currency,kind,status,occurred_at,correction_of,data) VALUES($1,$2,1000,'USD','correction','refunded',now(),$3,'{}')",
					[a.tenant.id, contact.id, target.rows[0].id]
				);
				await client.query(
					"INSERT INTO gifts(tenant_id,contact_id,amount_minor,currency,kind,status,occurred_at) VALUES($1,$2,2500,'EUR','one_time','recorded',now())",
					[a.tenant.id, contact.id]
				);
				await client.query(
					"INSERT INTO donation_intents(tenant_id,contact_id,stripe_account_id,request_key_hash,request_fingerprint,amount_minor,currency,frequency,status,donor_name,donor_email) VALUES($1,$2,'acct_fixture',$3,$4,5000,'USD','monthly','active','Ledger Donor','private@example.test')",
					[
						a.tenant.id,
						contact.id,
						crypto.randomUUID().replaceAll('-', '').repeat(2),
						crypto.randomUUID().replaceAll('-', '').repeat(2)
					]
				);
				await client.query('COMMIT');
			} catch (error) {
				await client.query('ROLLBACK');
				throw error;
			} finally {
				client.release();
			}
			const first = await givingSnapshot(session, undefined, { limit: 40 });
			expect(first.gifts).toHaveLength(40);
			expect(first.nextCursor).toBeTruthy();
			expect(first.summary).toContainEqual(
				expect.objectContaining({
					currency: 'USD',
					grossMinor: 1200000,
					refundMinor: 1000,
					netRecordedMinor: 1199000,
					giftCount: 120
				})
			);
			expect(first.summary).toContainEqual(
				expect.objectContaining({ currency: 'EUR', grossMinor: 2500 })
			);
			expect(first.gifts[0].contactName).toBe('Ledger Donor');
			expect(first.subscriptions).toContainEqual(
				expect.objectContaining({
					contactId: expectedContact,
					frequency: 'monthly',
					status: 'active',
					amountMinor: 5000
				})
			);
			const second = await givingSnapshot(session, undefined, {
				limit: 40,
				cursor: first.nextCursor!
			});
			expect(second.gifts).toHaveLength(40);
			expect(new Set([...first.gifts, ...second.gifts].map((gift: any) => gift.id)).size).toBe(80);
			const month = new Date().toISOString().slice(0, 7);
			const filtered = await givingSnapshot(session, undefined, { limit: 200, month });
			expect(filtered.summary).toContainEqual(
				expect.objectContaining({ currency: 'USD', grossMinor: 1200000 })
			);
		}
	);
});

it('rejects repeated normalized phones and invalid phone values in CSV review', async () => {
	const { analyzeContactCsv } = await import('../src/lib/server/csv');
	const result = analyzeContactCsv(
		'name,email,phone\nPerson A,,+1 (602) 555-0101\nPerson B,,+16025550101\nPerson C,,abc',
		[]
	);
	expect(result.createCount).toBe(1);
	expect(result.duplicateCount).toBe(1);
	expect(result.invalidCount).toBe(1);
});
