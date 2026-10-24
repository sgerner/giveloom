import { afterAll, describe, expect, it } from 'vitest';
import { createOwnerAccount, getPool } from '../src/lib/server/database';
import {
	createCampaign,
	createCampaignLink,
	createFundraisingPage,
	createVariant,
	getCampaign,
	listFunds,
	publicCampaign,
	publicFundraisingPage,
	publishCampaign,
	pauseCampaign,
	resumeCampaign,
	saveCampaignDraft,
	saveFund
} from '../src/lib/server/campaigns';
import {
	addPublicRegistration,
	addSponsor,
	addVolunteerOpportunity,
	checkInRegistration,
	createEvent,
	createTicketType,
	getEvent,
	publicEvent,
	publicRegistrationStatus,
	publishEvent,
	signupVolunteer
} from '../src/lib/server/event-management';
import { campaignEmailVariantResults } from '../src/lib/server/communications';

const enabled = !!process.env.DATABASE_URL && process.env.RUN_POSTGRES_MUTATION_TESTS === 'true';
afterAll(async () => {
	if (enabled) await getPool().end();
});

function validCampaign(name: string, publicSlug: string, fundId: string | null = null) {
	return {
		name,
		publicSlug,
		description: 'A community campaign with clear purpose.',
		story:
			'Neighbors are working together to make a lasting difference in our community. Every gift helps provide practical support and brings more people into this work.',
		goalMinor: 250_000,
		currency: 'USD',
		fundId,
		appealId: null,
		formConfig: {
			frequencies: ['once', 'monthly'],
			suggestedAmounts: [2500, 5000, 10000],
			allowCustomAmount: true,
			askForAddress: false,
			terms: 'I authorize this gift to support the organization.',
			privacyUrl: ''
		},
		acceptsOnlineGifts: false
	};
}

async function owner(prefix: string) {
	const suffix = crypto.randomUUID().slice(0, 8);
	const slug = `${prefix}-${suffix}`;
	const account = await createOwnerAccount({
		email: `${slug}@example.test`,
		name: 'Campaign Event Owner',
		passwordHash: 'fixture',
		organizationName: 'Campaign and Event Tests',
		slug,
		sessionExpiresAt: new Date(Date.now() + 3_600_000),
		testOnlyVerifiedFixture: true
	});
	return {
		session: { userId: account.userId, tenantSlug: slug, role: 'owner', demo: false },
		tenantId: account.tenantId,
		slug
	};
}

describe('campaign publishing, fundraising attribution, and events', () => {
	it.skipIf(!enabled)(
		'stores publishing controls and keeps scheduled or paused campaigns private',
		async () => {
			const a = await owner('campaign-publishing');
			const draft = {
				...validCampaign('Scheduled Community Drive', 'scheduled-community-drive'),
				startsAt: new Date(Date.now() + 86_400_000).toISOString(),
				endsAt: new Date(Date.now() + 172_800_000).toISOString(),
				budgetMinor: 750_000,
				channels: ['web', 'email'],
				audienceSegments: ['new_donors', 'volunteers'],
				utmSource: 'newsletter',
				utmMedium: 'email',
				utmCampaign: 'spring-drive',
				receiptTemplate: {
					thankYouMessage: 'Your gift helped our neighbors.',
					disclaimer: 'Donation acknowledgment only; consult your tax professional for advice.'
				}
			};
			const created = await createCampaign(a.session, draft);
			const published = await publishCampaign(a.session, created.id);
			expect(published.status).toBe('scheduled');
			expect(await publicCampaign(a.slug, 'scheduled-community-drive')).toBeNull();
			expect((await getCampaign(a.session, created.id)).draft).toMatchObject({
				budgetMinor: 750_000,
				channels: ['web', 'email'],
				audienceSegments: ['new_donors', 'volunteers'],
				utmSource: 'newsletter',
				utmMedium: 'email',
				utmCampaign: 'spring-drive',
				receiptTemplate: { thankYouMessage: 'Your gift helped our neighbors.' }
			});
			await pauseCampaign(a.session, created.id);
			expect(await publicCampaign(a.slug, 'scheduled-community-drive')).toBeNull();
			expect((await resumeCampaign(a.session, created.id)).status).toBe('scheduled');
			const emailClient = await getPool().connect();
			try {
				await emailClient.query('BEGIN');
				await emailClient.query("SELECT set_config('app.tenant_id',$1,true)", [a.tenantId]);
				const emailId = crypto.randomUUID(),
					batchId = crypto.randomUUID(),
					previewId = crypto.randomUUID();
				await emailClient.query(
					"INSERT INTO workspace_records(tenant_id,resource,id,data) VALUES($1,'emails',$2,$3)",
					[
						a.tenantId,
						emailId,
						{ name: 'Campaign update', subject: 'Default subject', body: 'Update' }
					]
				);
				await emailClient.query(
					"INSERT INTO email_send_batches(id,tenant_id,email_id,preview_id,approved_by,status,recipient_count,campaign_id) VALUES($1,$2,$3,$4,$5,'completed',2,$6)",
					[batchId, a.tenantId, emailId, previewId, a.session.userId, created.id]
				);
				for (const [variant, status] of [
					['A', 'delivered'],
					['B', 'bounced']
				] as const) {
					const contactId = crypto.randomUUID();
					const email = `${variant.toLowerCase()}-${crypto.randomUUID()}@example.test`;
					await emailClient.query(
						'INSERT INTO contacts(tenant_id,id,name,email) VALUES($1,$2,$3,$4)',
						[a.tenantId, contactId, `Donor ${variant}`, email]
					);
					await emailClient.query(
						"INSERT INTO email_messages(id,tenant_id,batch_id,email_id,contact_id,to_address,to_name,subject,body,from_address,idempotency_key,status,campaign_id,campaign_variant) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'Update','sender@example.test',$9,$10,$11,$12)",
						[
							crypto.randomUUID(),
							a.tenantId,
							batchId,
							emailId,
							contactId,
							email,
							`Donor ${variant}`,
							`Subject ${variant}`,
							`email.send:${batchId}:${contactId}`,
							status,
							created.id,
							variant
						]
					);
				}
				await emailClient.query('COMMIT');
			} catch (error) {
				await emailClient.query('ROLLBACK');
				throw error;
			} finally {
				emailClient.release();
			}
			expect(await campaignEmailVariantResults(a.session, created.id)).toMatchObject({
				variants: [
					{ variant: 'A', subject: 'Subject A', assigned: 1, delivered: 1 },
					{ variant: 'B', subject: 'Subject B', assigned: 1, bounced: 1 }
				]
			});
		}
	);

	it.skipIf(!enabled)(
		'persists campaign drafts and public pages with tenant isolation',
		async () => {
			const a = await owner('campaigns');
			const b = await owner('campaigns-other');
			const fund = await saveFund(a.session, {
				name: 'Neighborhood Fund',
				slug: 'neighborhood-fund',
				code: 'NH',
				restricted: true
			});
			expect((await listFunds(a.session)).map((item) => item.id)).toContain(fund.id);
			const campaign = await createCampaign(
				a.session,
				validCampaign('Spring Community Drive', 'spring-community-drive', fund.id)
			);
			expect(campaign).toMatchObject({ status: 'draft', version: 1 });
			await expect(getCampaign(b.session, campaign.id)).rejects.toMatchObject({ status: 404 });
			await expect(
				createCampaign(
					a.session,
					validCampaign(
						'Foreign Fund',
						'foreign-fund',
						(await saveFund(b.session, { name: 'Other Fund', slug: 'other-fund' })).id
					)
				)
			).rejects.toThrow();
			await expect(
				saveCampaignDraft({ ...a.session, role: 'viewer' }, campaign.id, {
					expectedVersion: 1,
					draft: validCampaign('Spring Community Drive', 'spring-community-drive', fund.id)
				})
			).rejects.toMatchObject({ status: 403 });

			const updated = validCampaign('Spring Community Drive', 'spring-community-drive', fund.id);
			updated.story +=
				' We are building a welcoming place where local families can find support and connection.';
			const saved = await saveCampaignDraft(a.session, campaign.id, {
				expectedVersion: 1,
				draft: updated
			});
			expect(saved.version).toBe(2);
			await expect(
				saveCampaignDraft(a.session, campaign.id, { expectedVersion: 1, draft: updated })
			).rejects.toMatchObject({ status: 409 });
			const published = await publishCampaign(a.session, campaign.id);
			expect(published.status).toBe('published');
			const variant = await createVariant(a.session, campaign.id, {
				name: 'Warm story',
				weight: 50,
				content: {
					headline: 'Neighbors helping neighbors',
					description: 'A local way to make a difference.'
				}
			});
			const client = await getPool().connect();
			let contactId: string;
			try {
				await client.query('BEGIN');
				await client.query("SELECT set_config('app.tenant_id',$1,true)", [a.tenantId]);
				contactId = String(
					(
						await client.query(
							"INSERT INTO contacts(tenant_id,name,email) VALUES($1,'Peer Page Owner',$2) RETURNING id",
							[a.tenantId, `peer-${crypto.randomUUID()}@example.test`]
						)
					).rows[0].id
				);
				await client.query('COMMIT');
			} catch (error) {
				await client.query('ROLLBACK');
				throw error;
			} finally {
				client.release();
			}
			const peer = await createFundraisingPage(a.session, campaign.id, {
				slug: `peer-${crypto.randomUUID().slice(0, 8)}`,
				pageType: 'individual',
				name: 'A Neighbor',
				story: 'I am raising support for neighbors who need a hand.',
				goalMinor: 50_000,
				contactId,
				publish: true
			});
			const link = await createCampaignLink(a.session, campaign.id, {
				label: 'Peer page',
				variantId: variant.id,
				fundraiserId: peer.id
			});
			expect(link.path).toContain(`ref=${link.code}`);
			const publicPage = await publicCampaign(a.slug, 'spring-community-drive', link.code);
			expect(publicPage?.campaign.id).toBe(campaign.id);
			expect(publicPage?.variant?.id).toBe(variant.id);
			expect(await publicFundraisingPage(a.slug, peer.slug)).toMatchObject({
				campaignId: campaign.id,
				raisedMinor: '0'
			});
			const auditClient = await getPool().connect();
			try {
				await auditClient.query('BEGIN');
				await auditClient.query("SELECT set_config('app.tenant_id',$1,true)", [a.tenantId]);
				const counts = await auditClient.query(
					'SELECT clicks FROM campaign_links WHERE tenant_id=$1 AND id=$2',
					[a.tenantId, link.id]
				);
				const history = await auditClient.query(
					'SELECT count(*)::int AS count FROM campaign_versions WHERE tenant_id=$1 AND campaign_id=$2',
					[a.tenantId, campaign.id]
				);
				expect(Number(counts.rows[0].clicks)).toBe(1);
				expect(Number(history.rows[0].count)).toBe(2);
				await auditClient.query('ROLLBACK');
			} finally {
				auditClient.release();
			}
		}
	);

	it.skipIf(!enabled)(
		'publishes free events, protects attendee data, checks capacity, and supports check-in',
		async () => {
			const a = await owner('events');
			const b = await owner('events-other');
			const startsAt = new Date(Date.now() + 86_400_000).toISOString();
			const event = await createEvent(a.session, {
				name: 'Community Welcome Night',
				publicSlug: 'community-welcome-night',
				description: 'Meet neighbors and learn about the work.',
				startsAt,
				timezone: 'America/Phoenix',
				venue: 'Community Hall',
				capacity: 2
			});
			const ticket = await createTicketType(a.session, event.id, {
				name: 'Free RSVP',
				priceMinor: 0,
				capacity: 2
			});
			const sponsor = await addSponsor(a.session, event.id, {
				organizationName: 'Local Library',
				tier: 'Community partner',
				amountMinor: 0,
				status: 'committed'
			});
			const opportunity = await addVolunteerOpportunity(a.session, event.id, {
				name: 'Welcome table',
				capacity: 1
			});
			await publishEvent(a.session, event.id);
			await expect(getEvent(b.session, event.id)).rejects.toMatchObject({ status: 404 });
			expect((await publicEvent(a.slug, event.publicSlug))?.sponsors).toContainEqual({
				organizationName: sponsor.organizationName,
				tier: sponsor.tier
			});
			const requestKey = crypto.randomUUID();
			const registered = await addPublicRegistration(a.slug, event.publicSlug, {
				ticketTypeId: ticket.id,
				quantity: 1,
				fullName: 'Event Guest',
				email: 'guest@example.test',
				requestKey
			});
			expect(registered).toMatchObject({ status: 'registered', existing: false });
			const ticketClient = await getPool().connect();
			try {
				await ticketClient.query('BEGIN');
				await ticketClient.query("SELECT set_config('app.tenant_id',$1,true)", [a.tenantId]);
				const linked = await ticketClient.query(
					'SELECT contact_id FROM event_registrations WHERE tenant_id=$1 AND id=$2',
					[a.tenantId, registered.id]
				);
				expect(linked.rows[0].contact_id).toBeTruthy();
				const attendee = await ticketClient.query(
					"SELECT id FROM contacts WHERE tenant_id=$1 AND id=$2 AND email='guest@example.test'",
					[a.tenantId, linked.rows[0].contact_id]
				);
				expect(attendee.rowCount).toBe(1);
				await ticketClient.query('ROLLBACK');
			} catch (error) {
				await ticketClient.query('ROLLBACK');
				throw error;
			} finally {
				ticketClient.release();
			}
			expect(
				await publicRegistrationStatus(a.slug, event.publicSlug, registered.publicRef!)
			).toMatchObject({ status: 'registered', quantity: 1 });
			const repeat = await addPublicRegistration(a.slug, event.publicSlug, {
				ticketTypeId: ticket.id,
				quantity: 1,
				fullName: 'Event Guest',
				email: 'guest@example.test',
				requestKey
			});
			expect(repeat).toMatchObject({ id: registered.id, existing: true });
			await expect(
				addPublicRegistration(a.slug, event.publicSlug, {
					ticketTypeId: ticket.id,
					quantity: 2,
					fullName: 'Second Guest',
					email: 'second@example.test',
					requestKey: crypto.randomUUID()
				})
			).rejects.toMatchObject({ status: 409 });
			await expect(checkInRegistration(b.session, event.id, registered.id)).rejects.toMatchObject({
				status: 404
			});
			await expect(
				signupVolunteer(a.slug, event.publicSlug, {
					opportunityId: opportunity.id,
					fullName: 'Helper One',
					email: 'helper@example.test'
				})
			).resolves.toMatchObject({ status: 'signed_up' });
			await expect(
				signupVolunteer(a.slug, event.publicSlug, {
					opportunityId: opportunity.id,
					fullName: 'Helper Two',
					email: 'helper2@example.test'
				})
			).rejects.toMatchObject({ status: 409 });
			expect(await checkInRegistration(a.session, event.id, registered.id)).toMatchObject({
				status: 'checked_in'
			});
			expect((await getEvent(a.session, event.id)).registrations[0]).toMatchObject({
				status: 'checked_in',
				email: 'guest@example.test'
			});
			await getPool().query(
				'UPDATE tenants SET suspended_at=now(),suspension_reason=$2 WHERE id=$1',
				[a.tenantId, 'test fixture']
			);
			expect(await publicEvent(a.slug, event.publicSlug)).toBeNull();
			await expect(
				addPublicRegistration(a.slug, event.publicSlug, {
					ticketTypeId: ticket.id,
					quantity: 1,
					fullName: 'Blocked Guest',
					email: 'blocked@example.test',
					requestKey: crypto.randomUUID()
				})
			).rejects.toMatchObject({ status: 404 });
		}
	);
});
