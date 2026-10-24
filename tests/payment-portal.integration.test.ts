import { afterAll, describe, expect, it } from 'vitest';
import type Stripe from 'stripe';
import { createOwnerAccount, getPool } from '../src/lib/server/database';
import { createCampaign, publishCampaign, saveFund } from '../src/lib/server/campaigns';
import {
	createDonationRequest,
	processStripeEvent,
	saveStripeAccount
} from '../src/lib/server/payments';

const enabled =
	Boolean(process.env.DATABASE_URL) && process.env.RUN_POSTGRES_MUTATION_TESTS === 'true';
afterAll(async () => {
	if (enabled) await getPool().end();
});

describe('payment designation snapshots and recurring status history', () => {
	it.skipIf(!enabled)(
		'keeps campaign attribution immutable, validates idempotency across campaigns, and records recurring lifecycle events once',
		async () => {
			const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 10);
			const slug = `payment-${suffix}`;
			const account = await createOwnerAccount({
				email: `owner-${suffix}@example.test`,
				name: 'Payment Test Owner',
				passwordHash: 'test-only-hash',
				organizationName: `Payment Test ${suffix}`,
				slug,
				sessionExpiresAt: new Date(Date.now() + 3_600_000),
				testOnlyVerifiedFixture: true
			});
			const session = { userId: account.userId, tenantSlug: slug, role: 'owner', demo: false };
			await saveStripeAccount(session, `acct_test_${suffix}`, false);
			const defaultFund = await saveFund(session, {
				name: 'General Fund',
				slug: `general-${suffix}`
			});
			const choiceFund = await saveFund(session, { name: 'Youth Fund', slug: `youth-${suffix}` });
			const formConfig = {
				frequencies: ['once', 'monthly'],
				suggestedAmounts: [5000, 10000],
				allowCustomAmount: true,
				askForAddress: true,
				allowAnonymous: true,
				allowTribute: true,
				allowFeeCoverage: true,
				feeCoverageBasisPoints: 290,
				feeCoverageFixedMinor: 30,
				allowDesignation: true,
				designationFundIds: [choiceFund.id],
				terms: 'I authorize this recurring or one-time donation.',
				privacyUrl: ''
			};
			const campaignInput = (name: string, publicSlug: string) => ({
				name,
				publicSlug,
				description: 'A focused community campaign.',
				story:
					'This campaign supports practical help for local families and neighbors who need additional support in the coming months.',
				goalMinor: 500_000,
				currency: 'USD',
				fundId: defaultFund.id,
				appealId: null,
				utmSource: 'spring-newsletter',
				utmMedium: 'email',
				utmCampaign: 'spring-drive',
				formConfig,
				acceptsOnlineGifts: false
			});
			const campaign = await createCampaign(
				session,
				campaignInput('First Payment Campaign', `first-${suffix}`)
			);
			const otherCampaign = await createCampaign(
				session,
				campaignInput('Second Payment Campaign', `second-${suffix}`)
			);
			await publishCampaign(session, campaign.id);
			await publishCampaign(session, otherCampaign.id);
			const enableClient = await getPool().connect();
			try {
				await enableClient.query('BEGIN');
				await enableClient.query("SELECT set_config('app.tenant_id',$1,true)", [account.tenantId]);
				await enableClient.query(
					"UPDATE campaigns SET data=jsonb_set(data,'{acceptsOnlineGifts}','true'::jsonb) WHERE tenant_id=$1 AND id=ANY($2::uuid[])",
					[account.tenantId, [campaign.id, otherCampaign.id]]
				);
				await enableClient.query('COMMIT');
			} catch (error) {
				await enableClient.query('ROLLBACK');
				throw error;
			} finally {
				enableClient.release();
			}
			const requestKey = crypto.randomUUID();
			const input = {
				tenant: slug,
				campaignId: campaign.id,
				requestKey,
				amountMinor: 10_000,
				frequency: 'monthly' as const,
				donorName: 'Test Donor',
				donorEmail: `donor-${suffix}@example.test`,
				termsAccepted: true as const,
				anonymous: true,
				feeCoverage: true,
				designationFundId: choiceFund.id,
				utm: { source: 'partner-newsletter', content: 'hero-link' },
				address: {
					line1: '10 Main St',
					city: 'Phoenix',
					region: 'AZ',
					postalCode: '85001',
					country: 'US'
				},
				tribute: {
					kind: 'honor' as const,
					honoree: 'Test Honoree',
					notifyEmail: `notify-${suffix}@example.test`
				}
			};
			const created = await createDonationRequest(input);
			expect(created.row.amount_minor).toBe('10330');
			expect(created.row.fee_covered_minor).toBe('330');
			expect(created.row.fund_id).toBe(choiceFund.id);
			expect(created.row.terms_text).toBe(formConfig.terms);
			expect(created.row.attribution_snapshot).toMatchObject({
				utmSource: 'partner-newsletter',
				utmMedium: 'email',
				utmCampaign: 'spring-drive',
				utmContent: 'hero-link'
			});
			const replay = await createDonationRequest(input);
			expect(replay).toMatchObject({ existing: true, row: { id: created.row.id } });
			await expect(
				createDonationRequest({ ...input, campaignId: otherCampaign.id })
			).rejects.toMatchObject({ status: 409 });
			const client = await getPool().connect();
			try {
				await client.query('BEGIN');
				await client.query("SELECT set_config('app.tenant_id',$1,true)", [account.tenantId]);
				await expect(
					client.query('UPDATE donation_intents SET fund_id=$3 WHERE tenant_id=$1 AND id=$2', [
						account.tenantId,
						created.row.id,
						defaultFund.id
					])
				).rejects.toThrow(/immutable/i);
				await client.query('ROLLBACK');
				await client.query('BEGIN');
				await client.query("SELECT set_config('app.tenant_id',$1,true)", [account.tenantId]);
				await expect(
					client.query(
						"UPDATE donation_intents SET attribution_snapshot='{}' WHERE tenant_id=$1 AND id=$2",
						[account.tenantId, created.row.id]
					)
				).rejects.toThrow(/immutable/i);
				await client.query('ROLLBACK');
			} catch (error) {
				await client.query('ROLLBACK');
				throw error;
			} finally {
				client.release();
			}

			const setup = await getPool().connect();
			try {
				await setup.query('BEGIN');
				await setup.query("SELECT set_config('app.tenant_id',$1,true)", [account.tenantId]);
				await setup.query(
					"UPDATE donation_intents SET stripe_subscription_id=$3,status='incomplete' WHERE tenant_id=$1 AND id=$2",
					[account.tenantId, created.row.id, `sub_test_${suffix}`]
				);
				await setup.query('COMMIT');
			} catch (error) {
				await setup.query('ROLLBACK');
				throw error;
			} finally {
				setup.release();
			}
			const event = {
				id: `evt_test_${suffix}`,
				object: 'event',
				account: `acct_test_${suffix}`,
				livemode: false,
				type: 'invoice.paid',
				created: Math.floor(Date.now() / 1000),
				data: {
					object: {
						id: `in_test_${suffix}`,
						subscription: `sub_test_${suffix}`,
						period_start: Math.floor(Date.now() / 1000),
						period_end: Math.floor(Date.now() / 1000) + 2_592_000,
						payment_intent: `pi_test_${suffix}`
					}
				}
			} as unknown as Stripe.Event;
			expect(await processStripeEvent(event, JSON.stringify(event))).toMatchObject({
				duplicate: false
			});
			expect(await processStripeEvent(event, JSON.stringify(event))).toMatchObject({
				duplicate: true
			});
			const refundEvent = {
				...event,
				id: `evt_refund_${suffix}`,
				type: 'refund.created',
				created: event.created + 1,
				data: {
					object: {
						id: `re_test_${suffix}`,
						status: 'succeeded',
						amount: 500,
						payment_intent: `pi_test_${suffix}`
					}
				}
			} as unknown as Stripe.Event;
			expect(await processStripeEvent(refundEvent, JSON.stringify(refundEvent))).toMatchObject({
				duplicate: false
			});
			const failedEvent = {
				...event,
				id: `evt_failed_${suffix}`,
				type: 'invoice.payment_failed',
				created: event.created + 2,
				data: {
					object: {
						id: `in_failed_${suffix}`,
						subscription: `sub_test_${suffix}`,
						period_start: event.created,
						period_end: event.created + 2_592_000
					}
				}
			} as unknown as Stripe.Event;
			expect(await processStripeEvent(failedEvent, JSON.stringify(failedEvent))).toMatchObject({
				duplicate: false
			});
			const reactivatedEvent = {
				...event,
				id: `evt_reactivated_${suffix}`,
				type: 'customer.subscription.updated',
				created: event.created + 3,
				data: {
					object: {
						id: `sub_test_${suffix}`,
						status: 'active',
						current_period_start: event.created,
						current_period_end: event.created + 2_592_000
					}
				}
			} as unknown as Stripe.Event;
			expect(
				await processStripeEvent(reactivatedEvent, JSON.stringify(reactivatedEvent))
			).toMatchObject({ duplicate: false });
			const history = await getPool().connect();
			try {
				await history.query('BEGIN');
				await history.query("SELECT set_config('app.tenant_id',$1,true)", [account.tenantId]);
				const rows = await history.query(
					'SELECT previous_status,new_status,event_type,effective_at FROM recurring_status_events WHERE tenant_id=$1 AND donation_intent_id=$2 ORDER BY effective_at',
					[account.tenantId, created.row.id]
				);
				expect(rows.rowCount).toBe(3);
				expect(rows.rows.map((row) => row.new_status)).toEqual(['active', 'past_due', 'active']);
				expect(rows.rows.map((row) => row.previous_status)).toEqual([
					'incomplete',
					'active',
					'past_due'
				]);
				const gifts = await history.query(
					'SELECT id,fund_id,amount_minor,data FROM gifts WHERE tenant_id=$1 AND external_event_id=$2',
					[account.tenantId, `stripe:invoice:in_test_${suffix}`]
				);
				expect(gifts.rows[0]).toMatchObject({ fund_id: choiceFund.id, amount_minor: '10330' });
				expect(gifts.rows[0].data.attribution).toMatchObject({
					utmSource: 'partner-newsletter',
					utmMedium: 'email',
					utmCampaign: 'spring-drive',
					utmContent: 'hero-link'
				});
				const correction = await history.query(
					'SELECT fund_id,amount_minor,correction_of FROM gifts WHERE tenant_id=$1 AND external_event_id=$2',
					[account.tenantId, `stripe:refund:re_test_${suffix}`]
				);
				expect(correction.rows[0]).toMatchObject({
					fund_id: choiceFund.id,
					amount_minor: '500',
					correction_of: gifts.rows[0].id
				});
				const details = await history.query(
					'SELECT method,donor_fee_minor,anonymous,designation FROM donation_financial_details WHERE tenant_id=$1 AND gift_id=$2',
					[account.tenantId, gifts.rows[0].id]
				);
				expect(details.rows[0]).toMatchObject({
					method: 'online',
					donor_fee_minor: '330',
					anonymous: true,
					designation: 'Youth Fund'
				});
				const tribute = await history.query(
					'SELECT honoree,kind FROM tributes WHERE tenant_id=$1 AND gift_id=$2',
					[account.tenantId, gifts.rows[0].id]
				);
				expect(tribute.rows[0]).toMatchObject({ honoree: 'Test Honoree', kind: 'honor' });
				const address = await history.query(
					'SELECT line1,country FROM addresses WHERE tenant_id=$1 AND contact_id=(SELECT contact_id FROM gifts WHERE tenant_id=$1 AND id=$2) AND preferred=true',
					[account.tenantId, gifts.rows[0].id]
				);
				expect(address.rows[0]).toMatchObject({ line1: '10 Main St', country: 'US' });
				await history.query('ROLLBACK');
			} catch (error) {
				await history.query('ROLLBACK');
				throw error;
			} finally {
				history.release();
			}
			await getPool().query(
				'UPDATE tenants SET suspended_at=now(),suspension_reason=$2 WHERE id=$1',
				[account.tenantId, 'test fixture']
			);
			await expect(
				createDonationRequest({ ...input, requestKey: crypto.randomUUID() })
			).rejects.toMatchObject({ status: 404 });
			const trustedLateEvent = {
				...event,
				id: `evt_suspended_${suffix}`,
				type: 'invoice.payment_failed',
				created: event.created + 4,
				data: {
					object: {
						id: `in_suspended_${suffix}`,
						subscription: `sub_test_${suffix}`,
						period_start: event.created,
						period_end: event.created + 2_592_000
					}
				}
			} as unknown as Stripe.Event;
			expect(
				await processStripeEvent(trustedLateEvent, JSON.stringify(trustedLateEvent))
			).toMatchObject({ duplicate: false });
		}
	);
});
