import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import {
	getPool,
	createOwnerAccount,
	mutatePostgres,
	mergePostgresContacts
} from '../src/lib/server/database';
import {
	consumePortalLink,
	createPortalBillingSession,
	getPortalOverview,
	getPortalReceipt,
	handlePortalMagicLinkOutboxEvent,
	requestPortalLink,
	revokePortalSession,
	updatePortalPreferences,
	updatePortalProfile
} from '../src/lib/server/portal';

const enabled =
	Boolean(process.env.DATABASE_URL) && process.env.RUN_POSTGRES_MUTATION_TESTS === 'true';
process.env.PUBLIC_APP_URL ||= 'https://donor-portal.example.test';

describe('donor portal PostgreSQL flow', () => {
	it.skipIf(!enabled)(
		'sends an opaque single-use link, scopes donor data, and revokes portal sessions',
		async () => {
			const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
			const slug = `portal-${suffix}`;
			const owner = await createOwnerAccount({
				email: `owner-${suffix}@example.test`,
				name: 'Portal Test Owner',
				passwordHash: 'test-only-hash',
				organizationName: `Portal Test ${suffix}`,
				slug,
				sessionExpiresAt: new Date(Date.now() + 60_000),
				testOnlyVerifiedFixture: true
			});
			const contact = await mutatePostgres(
				slug,
				owner.userId,
				'contacts',
				{ name: 'Portal Donor', email: `donor-${suffix}@example.test` },
				'create'
			);
			const privateContact = await mutatePostgres(
				slug,
				owner.userId,
				'contacts',
				{ name: 'Other Donor', email: `other-${suffix}@example.test` },
				'create'
			);
			const contactId = String((contact as Record<string, unknown>).id);
			const otherId = String((privateContact as Record<string, unknown>).id);
			const ownGift = await mutatePostgres(
				slug,
				owner.userId,
				'gifts',
				{ contactId, amountMinor: 3750, currency: 'USD', kind: 'one_time', status: 'recorded' },
				'create'
			);
			const otherGift = await mutatePostgres(
				slug,
				owner.userId,
				'gifts',
				{
					contactId: otherId,
					amountMinor: 9500,
					currency: 'USD',
					kind: 'one_time',
					status: 'recorded'
				},
				'create'
			);
			const ownGiftId = String((ownGift as Record<string, unknown>).id);
			const otherGiftId = String((otherGift as Record<string, unknown>).id);
			expect(await requestPortalLink(slug, `donor-${suffix}@example.test`)).toBe(true);
			const tenant = await getPool().query('SELECT id FROM tenants WHERE slug=$1', [slug]);
			const tenantId = String(tenant.rows[0].id);
			const client = await getPool().connect();
			let linkEventId = '';
			try {
				await client.query('BEGIN');
				await client.query("SELECT set_config('app.tenant_id',$1,true)", [tenantId]);
				const result = await client.query(
					"SELECT id,payload FROM outbox_events WHERE tenant_id=$1 AND event_type='portal.magic_link' ORDER BY created_at DESC LIMIT 1",
					[tenantId]
				);
				linkEventId = String(result.rows[0].payload.magicLinkId);
				await client.query('COMMIT');
			} catch (error) {
				await client.query('ROLLBACK');
				throw error;
			} finally {
				client.release();
			}
			expect(await requestPortalLink(slug, `unknown-${suffix}@example.test`)).toBe(false);
			let deliveredText = '';
			await handlePortalMagicLinkOutboxEvent(
				{ tenantId, payload: { magicLinkId: linkEventId } },
				getPool(),
				async (_tenant, message) => {
					deliveredText = message.text;
					return { id: 'test-transactional-message', status: 'accepted' };
				}
			);
			const token = deliveredText.match(/https:\/\/[^\s]+\/portal\/verify\/([^\s]+)/)?.[1];
			expect(token).toBeTruthy();
			const { cookie } = await consumePortalLink(decodeURIComponent(token!));
			const overview = await getPortalOverview(cookie);
			expect(overview?.contact.email).toBe(`donor-${suffix}@example.test`);
			expect(overview?.gifts.map((gift) => gift.id)).toContain(ownGiftId);
			expect(overview?.gifts.map((gift) => gift.id)).not.toContain(otherGiftId);
			expect(overview?.gifts[0].amountMinor).toBe(3750);
			await expect(consumePortalLink(decodeURIComponent(token!))).rejects.toMatchObject({
				status: 401
			});
			expect(await getPortalOverview(`${cookie.slice(0, -1)}x`)).toBeNull();
			await updatePortalPreferences(cookie, { newsletterOptIn: true, receiptEmails: false });
			await updatePortalProfile(cookie, {
				name: 'Portal Donor Updated',
				address: {
					line1: '123 Main St',
					line2: 'Unit 4',
					city: 'Phoenix',
					region: 'AZ',
					postalCode: '85001',
					country: 'US'
				}
			});
			expect((await getPortalOverview(cookie))?.contact.name).toBe('Portal Donor Updated');
			expect((await getPortalOverview(cookie))?.address).toMatchObject({
				line1: '123 Main St',
				city: 'Phoenix',
				country: 'US'
			});
			expect((await getPortalOverview(cookie))?.preferences).toEqual({
				receiptEmails: false,
				newsletterOptIn: true
			});
			const receiptClient = await getPool().connect();
			try {
				await receiptClient.query('BEGIN');
				await receiptClient.query("SELECT set_config('app.tenant_id',$1,true)", [tenantId]);
				await receiptClient.query(
					'INSERT INTO gift_receipts(tenant_id,gift_id,snapshot) VALUES($1,$2,$3)',
					[
						tenantId,
						ownGiftId,
						{
							receiptNumber: `G-${ownGiftId.slice(0, 8).toUpperCase()}`,
							organization: `Portal Test ${suffix}`,
							donorName: 'Portal Donor',
							amountMinor: 3750,
							currency: 'USD',
							occurredAt: new Date().toISOString(),
							campaignName: null,
							disclaimer: 'Acknowledgment only.'
						}
					]
				);
				await receiptClient.query('COMMIT');
			} catch (error) {
				await receiptClient.query('ROLLBACK');
				throw error;
			} finally {
				receiptClient.release();
			}
			const receipt = await getPortalReceipt(cookie, ownGiftId);
			expect(receipt.receiptNumber).toBe(`G-${ownGiftId.slice(0, 8).toUpperCase()}`);
			await expect(getPortalReceipt(cookie, otherGiftId)).rejects.toMatchObject({ status: 404 });
			expect(await requestPortalLink(slug, `donor-${suffix}@example.test`)).toBe(true);
			const pendingClient = await getPool().connect();
			let pendingLinkId = '';
			try {
				await pendingClient.query('BEGIN');
				await pendingClient.query("SELECT set_config('app.tenant_id',$1,true)", [tenantId]);
				const pending = await pendingClient.query(
					"SELECT id FROM portal_magic_links WHERE tenant_id=$1 AND contact_id=$2 AND delivery_status='queued' ORDER BY created_at DESC LIMIT 1",
					[tenantId, contactId]
				);
				pendingLinkId = String(pending.rows[0].id);
				await pendingClient.query(
					'UPDATE tenants SET suspended_at=now(),suspension_reason=$2 WHERE id=$1',
					[tenantId, 'Portal suspension test']
				);
				await pendingClient.query('COMMIT');
			} catch (error) {
				await pendingClient.query('ROLLBACK');
				throw error;
			} finally {
				pendingClient.release();
			}
			expect(await getPortalOverview(cookie)).toMatchObject({
				contact: { email: `donor-${suffix}@example.test` },
				tenantSuspended: true
			});
			expect((await getPortalReceipt(cookie, ownGiftId)).receiptNumber).toBe(receipt.receiptNumber);
			await expect(
				updatePortalPreferences(cookie, { newsletterOptIn: false })
			).rejects.toMatchObject({ status: 401 });
			await expect(
				updatePortalProfile(cookie, { name: 'Should not change', address: null })
			).rejects.toMatchObject({ status: 401 });
			await expect(createPortalBillingSession(cookie)).rejects.toMatchObject({ status: 401 });
			expect(await requestPortalLink(slug, `donor-${suffix}@example.test`)).toBe(false);
			let deliveredAfterSuspension = false;
			await handlePortalMagicLinkOutboxEvent(
				{ tenantId, payload: { magicLinkId: pendingLinkId } },
				getPool(),
				async () => {
					deliveredAfterSuspension = true;
					return { id: 'must-not-send', status: 'accepted' };
				}
			);
			expect(deliveredAfterSuspension).toBe(false);
			const resumeClient = await getPool().connect();
			try {
				await resumeClient.query('BEGIN');
				await resumeClient.query("SELECT set_config('app.tenant_id',$1,true)", [tenantId]);
				await resumeClient.query(
					'UPDATE tenants SET suspended_at=NULL,suspension_reason=NULL WHERE id=$1',
					[tenantId]
				);
				await resumeClient.query('COMMIT');
			} catch (error) {
				await resumeClient.query('ROLLBACK');
				throw error;
			} finally {
				resumeClient.release();
			}
			const canonical = await mutatePostgres(
				slug,
				owner.userId,
				'contacts',
				{ name: 'Canonical donor', email: `canonical-${suffix}@example.test` },
				'create'
			);
			await mergePostgresContacts(
				slug,
				owner.userId,
				contactId,
				String((canonical as Record<string, unknown>).id)
			);
			expect(await getPortalOverview(cookie)).toBeNull();
			await expect(getPortalReceipt(cookie, ownGiftId)).rejects.toMatchObject({ status: 401 });
			await revokePortalSession(cookie);
			expect(await getPortalOverview(cookie)).toBeNull();
		}
	);
});

afterAll(async () => {
	if (enabled) await getPool().end();
});
