import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import { getPool, type SessionClaims } from './database';
import { getPublicTenantBranding } from './branding';
import { env } from '$env/dynamic/private';

const editorRoles = new Set(['owner', 'admin', 'fundraising_manager', 'fundraiser']);
const idSchema = z.string().uuid();
const slugSchema = z
	.string()
	.trim()
	.min(3)
	.max(72)
	.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
export class EventError extends Error {
	constructor(
		message: string,
		readonly status = 400
	) {
		super(message);
		this.name = 'EventError';
	}
}

function activeSession(session: SessionClaims | null | undefined, tenant?: string, write = false) {
	if (!session) throw new EventError('Sign in before accessing event data.', 401);
	if (session.demo)
		throw new EventError(
			'Event management requires persistent storage and is unavailable in demo mode.',
			503
		);
	if (tenant && tenant !== session.tenantSlug) throw new EventError('Tenant access denied.', 403);
	if (write && !editorRoles.has(session.role))
		throw new EventError('Your role cannot manage events.', 403);
	return session;
}

async function tenantTransaction<T>(
	slug: string,
	task: (client: import('pg').PoolClient, tenantId: string) => Promise<T>
): Promise<T> {
	const pool = getPool();
	const tenant = await pool.query('SELECT id FROM tenants WHERE slug=$1', [slug]);
	if (!tenant.rowCount) throw new EventError('Workspace not found.', 404);
	const client = await pool.connect();
	try {
		await client.query('BEGIN');
		await client.query("SELECT set_config('app.tenant_id',$1,true)", [tenant.rows[0].id]);
		const value = await task(client, String(tenant.rows[0].id));
		await client.query('COMMIT');
		return value;
	} catch (error) {
		await client.query('ROLLBACK');
		throw error;
	} finally {
		client.release();
	}
}

const eventSchema = z
	.object({
		name: z.string().trim().min(3).max(140),
		publicSlug: slugSchema,
		description: z.string().trim().max(4000).default(''),
		startsAt: z.string().datetime(),
		endsAt: z.string().datetime().optional().or(z.literal('')),
		timezone: z.string().trim().min(1).max(80),
		venue: z.string().trim().max(240),
		capacity: z.number().int().positive().max(100_000).nullable().optional()
	})
	.strict();

export async function listEvents(session: SessionClaims | null | undefined) {
	const current = activeSession(session);
	return tenantTransaction(
		current.tenantSlug,
		async (client) =>
			(
				await client.query(
					'SELECT id,name,public_slug AS "publicSlug",description,starts_at AS "startsAt",ends_at AS "endsAt",timezone,venue,capacity,status,published_at AS "publishedAt",version FROM events ORDER BY starts_at DESC'
				)
			).rows
	);
}

export async function getEvent(session: SessionClaims | null | undefined, eventId: string) {
	const current = activeSession(session, undefined, true);
	if (!idSchema.safeParse(eventId).success) throw new EventError('Event not found.', 404);
	return tenantTransaction(current.tenantSlug, async (client, tenantId) => {
		const event = await client.query(
			'SELECT id,name,public_slug AS "publicSlug",description,starts_at AS "startsAt",ends_at AS "endsAt",timezone,venue,capacity,status,published_at AS "publishedAt",version FROM events WHERE tenant_id=$1 AND id=$2',
			[tenantId, eventId]
		);
		if (!event.rowCount) throw new EventError('Event not found.', 404);
		const tickets = await client.query(
			'SELECT id,name,description,price_minor AS "priceMinor",currency,capacity,active,sales_start AS "salesStart",sales_end AS "salesEnd" FROM event_ticket_types WHERE tenant_id=$1 AND event_id=$2 ORDER BY created_at',
			[tenantId, eventId]
		);
		const registrations = await client.query(
			'SELECT id,full_name AS "fullName",email,quantity,amount_minor AS "amountMinor",currency,status,registered_at AS "registeredAt",checked_in_at AS "checkedInAt" FROM event_registrations WHERE tenant_id=$1 AND event_id=$2 ORDER BY registered_at DESC',
			[tenantId, eventId]
		);
		const sponsors = await client.query(
			'SELECT id,organization_name AS "organizationName",contact_name AS "contactName",contact_email AS "contactEmail",tier,amount_minor AS "amountMinor",status FROM event_sponsors WHERE tenant_id=$1 AND event_id=$2 ORDER BY created_at DESC',
			[tenantId, eventId]
		);
		const opportunities = await client.query(
			'SELECT id,name,description,starts_at AS "startsAt",ends_at AS "endsAt",capacity,active FROM event_volunteer_opportunities WHERE tenant_id=$1 AND event_id=$2 ORDER BY starts_at',
			[tenantId, eventId]
		);
		const volunteers = await client.query(
			'SELECT s.id,s.opportunity_id AS "opportunityId",o.name AS "opportunityName",s.full_name AS "fullName",s.email,s.status FROM event_volunteer_signups s JOIN event_volunteer_opportunities o ON o.tenant_id=s.tenant_id AND o.event_id=s.event_id AND o.id=s.opportunity_id WHERE s.tenant_id=$1 AND s.event_id=$2 ORDER BY s.created_at DESC',
			[tenantId, eventId]
		);
		return {
			...event.rows[0],
			tickets: tickets.rows,
			registrations: registrations.rows,
			sponsors: sponsors.rows,
			volunteerOpportunities: opportunities.rows,
			volunteers: volunteers.rows
		};
	});
}

export async function createEvent(session: SessionClaims | null | undefined, input: unknown) {
	const current = activeSession(session, undefined, true);
	const body = eventSchema.parse(input);
	if (body.endsAt && new Date(body.endsAt) <= new Date(body.startsAt))
		throw new EventError('Event end time must be after the start time.', 422);
	return tenantTransaction(current.tenantSlug, async (client, tenantId) => {
		const result = await client.query(
			`INSERT INTO events(tenant_id,name,public_slug,description,starts_at,ends_at,timezone,venue,capacity) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id,name,public_slug AS "publicSlug",description,starts_at AS "startsAt",ends_at AS "endsAt",timezone,venue,capacity,status,version`,
			[
				tenantId,
				body.name,
				body.publicSlug,
				body.description,
				body.startsAt,
				body.endsAt || null,
				body.timezone,
				body.venue,
				body.capacity ?? null
			]
		);
		await client.query(
			'INSERT INTO audit_log(tenant_id,actor_id,action,resource,record_id,details) VALUES($1,$2,$3,$4,$5,$6)',
			[tenantId, current.userId, 'event.created', 'events', result.rows[0].id, { name: body.name }]
		);
		return result.rows[0];
	});
}

export async function updateEvent(
	session: SessionClaims | null | undefined,
	eventId: string,
	input: unknown
) {
	const current = activeSession(session, undefined, true);
	const body = eventSchema
		.partial()
		.extend({ expectedVersion: z.number().int().min(1) })
		.strict()
		.parse(input);
	return tenantTransaction(current.tenantSlug, async (client, tenantId) => {
		const old = await client.query('SELECT * FROM events WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [
			tenantId,
			eventId
		]);
		if (!old.rowCount) throw new EventError('Event not found.', 404);
		if (Number(old.rows[0].version) !== body.expectedVersion)
			throw new EventError('This event changed in another editor. Reload before saving.', 409);
		const currentEvent = old.rows[0];
		const merged = eventSchema.parse({
			name: body.name ?? currentEvent.name,
			publicSlug: body.publicSlug ?? currentEvent.public_slug,
			description: body.description ?? currentEvent.description,
			startsAt: body.startsAt ?? new Date(currentEvent.starts_at).toISOString(),
			endsAt:
				body.endsAt ?? (currentEvent.ends_at ? new Date(currentEvent.ends_at).toISOString() : ''),
			timezone: body.timezone ?? currentEvent.timezone,
			venue: body.venue ?? currentEvent.venue,
			capacity: body.capacity === undefined ? currentEvent.capacity : body.capacity
		});
		const updated = await client.query(
			'UPDATE events SET name=$3,public_slug=$4,description=$5,starts_at=$6,ends_at=$7,timezone=$8,venue=$9,capacity=$10,version=version+1,updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING id,name,public_slug AS "publicSlug",description,starts_at AS "startsAt",ends_at AS "endsAt",timezone,venue,capacity,status,version',
			[
				tenantId,
				eventId,
				merged.name,
				merged.publicSlug,
				merged.description,
				merged.startsAt,
				merged.endsAt || null,
				merged.timezone,
				merged.venue,
				merged.capacity ?? null
			]
		);
		return updated.rows[0];
	});
}

export async function publishEvent(session: SessionClaims | null | undefined, eventId: string) {
	const current = activeSession(session, undefined, true);
	return tenantTransaction(current.tenantSlug, async (client, tenantId) => {
		const event = await client.query(
			'SELECT * FROM events WHERE tenant_id=$1 AND id=$2 FOR UPDATE',
			[tenantId, eventId]
		);
		if (!event.rowCount) throw new EventError('Event not found.', 404);
		const tickets = await client.query(
			'SELECT id,price_minor FROM event_ticket_types WHERE tenant_id=$1 AND event_id=$2 AND active=true',
			[tenantId, eventId]
		);
		if (!tickets.rowCount)
			throw new EventError('Add at least one active RSVP or ticket type before publishing.', 422);
		if (tickets.rows.some((ticket) => Number(ticket.price_minor) > 0)) {
			if (
				!env.DATABASE_URL ||
				!env.STRIPE_PLATFORM_SECRET_KEY ||
				!env.STRIPE_CONNECT_PUBLISHABLE_KEY
			)
				throw new EventError('Configure Stripe before publishing paid tickets.', 422);
			const account = await client.query(
				'SELECT livemode FROM stripe_accounts WHERE tenant_id=$1 AND enabled=true AND disconnected_at IS NULL',
				[tenantId]
			);
			if (
				!account.rowCount ||
				account.rows[0].livemode !== env.STRIPE_PLATFORM_SECRET_KEY.startsWith('sk_live_')
			)
				throw new EventError(
					'Connect an active Stripe account in the configured payment mode before publishing paid tickets.',
					422
				);
		}
		const result = await client.query(
			'UPDATE events SET status=\'published\',published_at=now(),updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING id,status,public_slug AS "publicSlug",published_at AS "publishedAt"',
			[tenantId, eventId]
		);
		await client.query(
			'INSERT INTO audit_log(tenant_id,actor_id,action,resource,record_id) VALUES($1,$2,$3,$4,$5)',
			[tenantId, current.userId, 'event.published', 'events', eventId]
		);
		return result.rows[0];
	});
}

export async function createTicketType(
	session: SessionClaims | null | undefined,
	eventId: string,
	input: unknown
) {
	const current = activeSession(session, undefined, true);
	const body = z
		.object({
			name: z.string().trim().min(2).max(120),
			description: z.string().trim().max(500).default(''),
			priceMinor: z.number().int().min(0).max(25_000_000),
			capacity: z.number().int().positive().max(100_000).nullable().optional(),
			salesStart: z.string().datetime().optional(),
			salesEnd: z.string().datetime().optional()
		})
		.strict()
		.parse(input);
	return tenantTransaction(current.tenantSlug, async (client, tenantId) => {
		const result = await client.query(
			`INSERT INTO event_ticket_types(tenant_id,event_id,name,description,price_minor,currency,capacity,sales_start,sales_end) SELECT $1,e.id,$3,$4,$5,t.currency,$6,$7,$8 FROM events e JOIN tenants t ON t.id=e.tenant_id WHERE e.tenant_id=$1 AND e.id=$2 RETURNING id,name,description,price_minor AS "priceMinor",currency,capacity,active,sales_start AS "salesStart",sales_end AS "salesEnd"`,
			[
				tenantId,
				eventId,
				body.name,
				body.description,
				body.priceMinor,
				body.capacity ?? null,
				body.salesStart || null,
				body.salesEnd || null
			]
		);
		if (!result.rowCount) throw new EventError('Event not found.', 404);
		return result.rows[0];
	});
}

export async function addSponsor(
	session: SessionClaims | null | undefined,
	eventId: string,
	input: unknown
) {
	const current = activeSession(session, undefined, true);
	const body = z
		.object({
			organizationName: z.string().trim().min(2).max(160),
			contactName: z.string().trim().max(120).default(''),
			contactEmail: z.string().trim().email().max(254).or(z.literal('')).default(''),
			tier: z.string().trim().min(2).max(80),
			amountMinor: z.number().int().min(0).max(25_000_000_000),
			status: z.enum(['prospect', 'committed', 'paid', 'declined']).default('prospect')
		})
		.strict()
		.parse(input);
	return tenantTransaction(current.tenantSlug, async (client, tenantId) => {
		const result = await client.query(
			'INSERT INTO event_sponsors(tenant_id,event_id,organization_name,contact_name,contact_email,tier,amount_minor,status) SELECT $1,id,$3,$4,$5,$6,$7,$8 FROM events WHERE tenant_id=$1 AND id=$2 RETURNING id,organization_name AS "organizationName",contact_name AS "contactName",contact_email AS "contactEmail",tier,amount_minor AS "amountMinor",status',
			[
				tenantId,
				eventId,
				body.organizationName,
				body.contactName,
				body.contactEmail,
				body.tier,
				body.amountMinor,
				body.status
			]
		);
		if (!result.rowCount) throw new EventError('Event not found.', 404);
		return result.rows[0];
	});
}

export async function addVolunteerOpportunity(
	session: SessionClaims | null | undefined,
	eventId: string,
	input: unknown
) {
	const current = activeSession(session, undefined, true);
	const body = z
		.object({
			name: z.string().trim().min(2).max(120),
			description: z.string().trim().max(1000).default(''),
			startsAt: z.string().datetime().optional(),
			endsAt: z.string().datetime().optional(),
			capacity: z.number().int().positive().max(5000)
		})
		.strict()
		.parse(input);
	return tenantTransaction(current.tenantSlug, async (client, tenantId) => {
		const result = await client.query(
			'INSERT INTO event_volunteer_opportunities(tenant_id,event_id,name,description,starts_at,ends_at,capacity) SELECT $1,id,$3,$4,$5,$6,$7 FROM events WHERE tenant_id=$1 AND id=$2 RETURNING id,name,description,starts_at AS "startsAt",ends_at AS "endsAt",capacity,active',
			[
				tenantId,
				eventId,
				body.name,
				body.description,
				body.startsAt || null,
				body.endsAt || null,
				body.capacity
			]
		);
		if (!result.rowCount) throw new EventError('Event not found.', 404);
		return result.rows[0];
	});
}

export async function checkInRegistration(
	session: SessionClaims | null | undefined,
	eventId: string,
	registrationId: string
) {
	const current = activeSession(session, undefined, true);
	return tenantTransaction(current.tenantSlug, async (client, tenantId) => {
		const row = await client.query(
			"UPDATE event_registrations SET status='checked_in',checked_in_at=now() WHERE tenant_id=$1 AND event_id=$2 AND id=$3 AND status='registered' RETURNING id,status,checked_in_at AS \"checkedInAt\"",
			[tenantId, eventId, registrationId]
		);
		if (!row.rowCount)
			throw new EventError('Registration not found or not eligible for check-in.', 404);
		await client.query(
			'INSERT INTO audit_log(tenant_id,actor_id,action,resource,record_id,details) VALUES($1,$2,$3,$4,$5,$6)',
			[
				tenantId,
				current.userId,
				'event.attendee.checked_in',
				'event_registrations',
				registrationId,
				{ eventId }
			]
		);
		return row.rows[0];
	});
}

export async function publicEvent(tenantSlug: string, slug: string) {
	const pool = getPool();
	const tenant = await pool.query(
		'SELECT id,legal_name,currency FROM tenants WHERE slug=$1 AND suspended_at IS NULL',
		[tenantSlug]
	);
	if (!tenant.rowCount) return null;
	const branding = await getPublicTenantBranding(tenantSlug);
	return tenantTransaction(tenantSlug, async (client, tenantId) => {
		const event = await client.query(
			'SELECT id,name,public_slug AS "publicSlug",description,starts_at AS "startsAt",ends_at AS "endsAt",timezone,venue,capacity,registration_config AS "registrationConfig" FROM events WHERE tenant_id=$1 AND public_slug=$2 AND status=\'published\'',
			[tenantId, slug]
		);
		if (!event.rowCount) return null;
		const tickets = await client.query(
			'SELECT tt.id,tt.name,tt.description,tt.price_minor AS "priceMinor",tt.currency,tt.capacity,tt.sales_start AS "salesStart",tt.sales_end AS "salesEnd",coalesce((SELECT sum(r.quantity) FROM event_registrations r WHERE r.tenant_id=tt.tenant_id AND r.ticket_type_id=tt.id AND r.status IN (\'pending_payment\',\'registered\',\'checked_in\')),0) AS reserved FROM event_ticket_types tt WHERE tt.tenant_id=$1 AND tt.event_id=$2 AND tt.active=true AND (tt.sales_start IS NULL OR tt.sales_start<=now()) AND (tt.sales_end IS NULL OR tt.sales_end>now())',
			[tenantId, event.rows[0].id]
		);
		const opportunities = await client.query(
			'SELECT o.id,o.name,o.description,o.starts_at AS "startsAt",o.ends_at AS "endsAt",o.capacity,coalesce((SELECT count(*) FROM event_volunteer_signups s WHERE s.tenant_id=o.tenant_id AND s.opportunity_id=o.id AND s.status=\'signed_up\'),0) AS reserved FROM event_volunteer_opportunities o WHERE o.tenant_id=$1 AND o.event_id=$2 AND o.active=true ORDER BY o.starts_at',
			[tenantId, event.rows[0].id]
		);
		const sponsors = await client.query(
			"SELECT organization_name AS \"organizationName\",tier FROM event_sponsors WHERE tenant_id=$1 AND event_id=$2 AND status IN ('committed','paid') ORDER BY created_at",
			[tenantId, event.rows[0].id]
		);
		return {
			organization: branding?.publicName || tenant.rows[0].legal_name,
			branding,
			tenant: tenantSlug,
			currency: tenant.rows[0].currency,
			event: event.rows[0],
			tickets: tickets.rows,
			volunteerOpportunities: opportunities.rows,
			sponsors: sponsors.rows
		};
	});
}

export async function addPublicRegistration(tenantSlug: string, eventSlug: string, input: unknown) {
	const body = z
		.object({
			ticketTypeId: idSchema,
			quantity: z.number().int().min(1).max(12),
			fullName: z.string().trim().min(2).max(120),
			email: z.string().trim().email().max(254),
			requestKey: z
				.string()
				.min(16)
				.max(128)
				.regex(/^[A-Za-z0-9._-]+$/)
		})
		.strict()
		.parse(input);
	const activeTenant = await getPool().query(
		'SELECT id FROM tenants WHERE slug=$1 AND suspended_at IS NULL',
		[tenantSlug]
	);
	if (!activeTenant.rowCount) throw new EventError('Event registration is unavailable.', 404);
	return tenantTransaction(tenantSlug, async (client, tenantId) => {
		const stillActive = await client.query(
			'SELECT 1 FROM tenants WHERE id=$1 AND suspended_at IS NULL FOR SHARE',
			[tenantId]
		);
		if (!stillActive.rowCount) throw new EventError('Event registration is unavailable.', 404);
		const ev = await client.query(
			"SELECT id,capacity FROM events WHERE tenant_id=$1 AND public_slug=$2 AND status='published' FOR UPDATE",
			[tenantId, eventSlug]
		);
		if (!ev.rowCount) throw new EventError('Event registration is unavailable.', 404);
		const eventId = String(ev.rows[0].id);
		const existing = await client.query(
			'SELECT id,status,amount_minor AS "amountMinor",currency,stripe_account_id AS "stripeAccountId",stripe_payment_intent_id AS "stripePaymentIntentId" FROM event_registrations WHERE tenant_id=$1 AND event_id=$2 AND request_key=$3',
			[tenantId, eventId, body.requestKey]
		);
		if (existing.rowCount) return { ...existing.rows[0], existing: true };
		const ticket = await client.query(
			'SELECT * FROM event_ticket_types WHERE tenant_id=$1 AND event_id=$2 AND id=$3 AND active=true AND (sales_start IS NULL OR sales_start<=now()) AND (sales_end IS NULL OR sales_end>now()) FOR UPDATE',
			[tenantId, eventId, body.ticketTypeId]
		);
		if (!ticket.rowCount) throw new EventError('That ticket type is unavailable.', 422);
		if (
			Number(ticket.rows[0].price_minor) > 0 &&
			(!env.DATABASE_URL ||
				!env.STRIPE_PLATFORM_SECRET_KEY ||
				!env.STRIPE_CONNECT_PUBLISHABLE_KEY ||
				!/^pk_(live|test)_[A-Za-z0-9]+$/.test(env.STRIPE_CONNECT_PUBLISHABLE_KEY) ||
				env.STRIPE_CONNECT_PUBLISHABLE_KEY.startsWith('pk_live_') !==
					env.STRIPE_PLATFORM_SECRET_KEY.startsWith('sk_live_'))
		)
			throw new EventError('Paid event registration is not configured.', 503);
		const reserved = await client.query(
			"SELECT coalesce(sum(quantity),0) AS count FROM event_registrations WHERE tenant_id=$1 AND event_id=$2 AND ticket_type_id=$3 AND status IN ('pending_payment','registered','checked_in')",
			[tenantId, eventId, body.ticketTypeId]
		);
		if (
			ticket.rows[0].capacity !== null &&
			Number(reserved.rows[0].count) + body.quantity > Number(ticket.rows[0].capacity)
		)
			throw new EventError('There are not enough tickets remaining.', 409);
		if (ev.rows[0].capacity !== null) {
			const eventReserved = await client.query(
				"SELECT coalesce(sum(quantity),0) AS count FROM event_registrations WHERE tenant_id=$1 AND event_id=$2 AND status IN ('pending_payment','registered','checked_in')",
				[tenantId, eventId]
			);
			if (Number(eventReserved.rows[0].count) + body.quantity > Number(ev.rows[0].capacity))
				throw new EventError('This event has reached its registration capacity.', 409);
		}
		const amountMinor = Number(ticket.rows[0].price_minor) * body.quantity;
		if (!Number.isSafeInteger(amountMinor) || amountMinor > 25_000_000)
			throw new EventError('Ticket total exceeds the allowed amount.', 422);
		let accountId: string | null = null;
		if (amountMinor > 0) {
			const connected = await client.query(
				'SELECT connected_account_id,livemode FROM stripe_accounts WHERE tenant_id=$1 AND enabled=true AND disconnected_at IS NULL',
				[tenantId]
			);
			if (!connected.rowCount)
				throw new EventError('This event cannot take paid registrations right now.', 503);
			const platformSecret = env.STRIPE_PLATFORM_SECRET_KEY;
			if (!platformSecret)
				throw new EventError(
					'Paid event registration is unavailable until the platform payment mode is configured.',
					503
				);
			if (connected.rows[0].livemode !== platformSecret.startsWith('sk_live_'))
				throw new EventError(
					'The connected account is unavailable in the current payment mode.',
					503
				);
			accountId = String(connected.rows[0].connected_account_id);
		}
		const id = randomUUID();
		const matchingContacts = await client.query(
			'SELECT id FROM contacts WHERE tenant_id=$1 AND lower(email)=lower($2) AND archived_at IS NULL AND merged_into IS NULL ORDER BY created_at LIMIT 2',
			[tenantId, body.email.toLowerCase()]
		);
		let contactId: string | null =
			matchingContacts.rowCount === 1 ? String(matchingContacts.rows[0].id) : null;
		if (!matchingContacts.rowCount) {
			const historical = await client.query(
				'SELECT 1 FROM contacts WHERE tenant_id=$1 AND lower(email)=lower($2) LIMIT 1',
				[tenantId, body.email.toLowerCase()]
			);
			if (!historical.rowCount) {
				const created = await client.query(
					"INSERT INTO contacts(tenant_id,name,email,stage,tags,data) VALUES($1,$2,$3,'new',ARRAY['event_attendee'],$4::jsonb) RETURNING id",
					[
						tenantId,
						body.fullName,
						body.email.toLowerCase(),
						JSON.stringify({ source: 'event_registration' })
					]
				);
				contactId = String(created.rows[0].id);
			}
		}
		const publicRef = randomBytes(24).toString('base64url');
		const status = amountMinor ? 'pending_payment' : 'registered';
		const inserted = await client.query(
			'INSERT INTO event_registrations(tenant_id,id,event_id,ticket_type_id,contact_id,full_name,email,quantity,amount_minor,currency,status,request_key,public_ref_hash,stripe_account_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id,status,amount_minor AS "amountMinor",currency,stripe_account_id AS "stripeAccountId"',
			[
				tenantId,
				id,
				eventId,
				body.ticketTypeId,
				contactId,
				body.fullName,
				body.email.toLowerCase(),
				body.quantity,
				amountMinor,
				String(ticket.rows[0].currency).trim().toUpperCase(),
				status,
				body.requestKey,
				createHash('sha256').update(publicRef).digest('hex'),
				accountId
			]
		);
		if (status === 'registered')
			await client.query(
				'INSERT INTO audit_log(tenant_id,action,resource,record_id,details) VALUES($1,$2,$3,$4,$5)',
				[
					tenantId,
					'event.registration.created',
					'event_registrations',
					id,
					{ eventId, quantity: body.quantity }
				]
			);
		return { ...inserted.rows[0], publicRef, existing: false };
	});
}

export async function attachTicketPayment(
	tenantSlug: string,
	registrationId: string,
	paymentIntentId: string
) {
	return tenantTransaction(tenantSlug, async (client, tenantId) => {
		const result = await client.query(
			"UPDATE event_registrations SET stripe_payment_intent_id=$3 WHERE tenant_id=$1 AND id=$2 AND status='pending_payment' AND stripe_payment_intent_id IS NULL RETURNING id",
			[tenantId, registrationId, paymentIntentId]
		);
		if (!result.rowCount)
			throw new EventError('Ticket payment could not be attached to the registration.', 409);
	});
}

export async function markTicketPayment(
	tenantId: string,
	accountId: string,
	registrationId: string,
	paymentIntentId: string,
	succeeded: boolean,
	amountMinor: number,
	currency: string
) {
	const client = await getPool().connect();
	try {
		await client.query('BEGIN');
		await client.query("SELECT set_config('app.tenant_id',$1,true)", [tenantId]);
		const row = await client.query(
			'SELECT id,amount_minor,currency,status,stripe_account_id,stripe_payment_intent_id FROM event_registrations WHERE tenant_id=$1 AND id=$2 FOR UPDATE',
			[tenantId, registrationId]
		);
		if (!row.rowCount) {
			await client.query('ROLLBACK');
			return false;
		}
		const entry = row.rows[0];
		if (
			entry.stripe_account_id !== accountId ||
			entry.stripe_payment_intent_id !== paymentIntentId ||
			Number(entry.amount_minor) !== amountMinor ||
			String(entry.currency).trim().toLowerCase() !== currency.toLowerCase()
		)
			throw new EventError('Ticket payment does not match its registration.', 422);
		if (entry.status === 'registered') {
			await client.query('COMMIT');
			return true;
		}
		const status = succeeded ? 'registered' : 'payment_failed';
		await client.query(
			"UPDATE event_registrations SET status=$3 WHERE tenant_id=$1 AND id=$2 AND status IN ('pending_payment','payment_failed')",
			[tenantId, registrationId, status]
		);
		if (succeeded)
			await client.query(
				'INSERT INTO audit_log(tenant_id,action,resource,record_id,details) VALUES($1,$2,$3,$4,$5)',
				[tenantId, 'event.registration.paid', 'event_registrations', registrationId, { accountId }]
			);
		await client.query('COMMIT');
		return true;
	} catch (error) {
		await client.query('ROLLBACK');
		throw error;
	} finally {
		client.release();
	}
}

export async function publicRegistrationStatus(
	tenantSlug: string,
	eventSlug: string,
	publicRef: string
) {
	if (publicRef.length < 24 || publicRef.length > 64)
		throw new EventError('Registration not found.', 404);
	return tenantTransaction(tenantSlug, async (client, tenantId) => {
		const result = await client.query(
			'SELECT r.status,r.quantity,r.amount_minor AS "amountMinor",r.currency FROM event_registrations r JOIN events e ON e.tenant_id=r.tenant_id AND e.id=r.event_id WHERE r.tenant_id=$1 AND e.public_slug=$2 AND r.public_ref_hash=$3',
			[tenantId, eventSlug, createHash('sha256').update(publicRef).digest('hex')]
		);
		if (!result.rowCount) throw new EventError('Registration not found.', 404);
		return result.rows[0];
	});
}

export async function signupVolunteer(tenantSlug: string, eventSlug: string, input: unknown) {
	const body = z
		.object({
			opportunityId: idSchema,
			fullName: z.string().trim().min(2).max(120),
			email: z.string().trim().email().max(254)
		})
		.strict()
		.parse(input);
	return tenantTransaction(tenantSlug, async (client, tenantId) => {
		const event = await client.query(
			"SELECT id FROM events WHERE tenant_id=$1 AND public_slug=$2 AND status='published'",
			[tenantId, eventSlug]
		);
		if (!event.rowCount) throw new EventError('Volunteer sign-up is unavailable.', 404);
		const opportunity = await client.query(
			'SELECT id,capacity FROM event_volunteer_opportunities WHERE tenant_id=$1 AND event_id=$2 AND id=$3 AND active=true FOR UPDATE',
			[tenantId, event.rows[0].id, body.opportunityId]
		);
		if (!opportunity.rowCount) throw new EventError('Volunteer opportunity is unavailable.', 404);
		const count = await client.query(
			"SELECT count(*)::integer AS count FROM event_volunteer_signups WHERE tenant_id=$1 AND opportunity_id=$2 AND status='signed_up'",
			[tenantId, body.opportunityId]
		);
		if (Number(count.rows[0].count) >= Number(opportunity.rows[0].capacity))
			throw new EventError('This volunteer opportunity is full.', 409);
		const result = await client.query(
			'INSERT INTO event_volunteer_signups(tenant_id,event_id,opportunity_id,full_name,email) VALUES($1,$2,$3,$4,$5) RETURNING id,status',
			[tenantId, event.rows[0].id, body.opportunityId, body.fullName, body.email.toLowerCase()]
		);
		return result.rows[0];
	});
}

export function validateEventSlug(value: string) {
	return slugSchema.parse(value);
}
