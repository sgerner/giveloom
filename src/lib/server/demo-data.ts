import type { Resource, Workspace } from './domain';

const uid = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const now = '2026-10-22T16:00:00.000Z';

function makeWorkspace(slug: string, name: string, offset: number): Workspace {
	const people = [
		['Maya Chen', 'maya.chen@example.test', 'Major donor', 'monthly'],
		['Elliot Rivera', 'elliot.rivera@example.test', 'Leadership circle', 'annual'],
		['Nina Patel', 'nina.patel@example.test', 'First-time', 'new'],
		['Jonah Brooks', 'jonah.brooks@example.test', 'Recurring', 'monthly'],
		['Amara Okafor', 'amara.okafor@example.test', 'Sustainer', 'monthly'],
		['Theo Martin', 'theo.martin@example.test', 'Lapsed', 'annual'],
		['Grace Kim', 'grace.kim@example.test', 'Volunteer', 'new'],
		['Luis Alvarez', 'luis.alvarez@example.test', 'Leadership circle', 'annual'],
		['Priya Shah', 'priya.shah@example.test', 'Recurring', 'monthly'],
		['Oliver Grant', 'oliver.grant@example.test', 'Major donor', 'annual'],
		['Sofia Nguyen', 'sofia.nguyen@example.test', 'First-time', 'new'],
		['Caleb Johnson', 'caleb.johnson@example.test', 'Sustainer', 'monthly'],
		['Ava Wilson', 'ava.wilson@example.test', 'Volunteer', 'annual'],
		['Noah Thompson', 'noah.thompson@example.test', 'Recurring', 'monthly'],
		['Zara Hassan', 'zara.hassan@example.test', 'Lapsed', 'annual'],
		['Miles Davis', 'miles.davis@example.test', 'Leadership circle', 'annual'],
		['Isabel Torres', 'isabel.torres@example.test', 'First-time', 'new'],
		['Henry Adams', 'henry.adams@example.test', 'Sustainer', 'monthly'],
		['Leila Morgan', 'leila.morgan@example.test', 'Major donor', 'annual'],
		['Sam Parker', 'sam.parker@example.test', 'Volunteer', 'new']
	];
	const contacts = people.map(([person, email, stage, cadence], i) => ({
		id: uid(offset + i + 1),
		name: person,
		email,
		stage,
		cadence,
		tags: [stage.toLowerCase().replaceAll(' ', '-')],
		source: i % 3 ? 'Community event' : 'Website',
		lastGiftAt: new Date(Date.UTC(2026, 9 - (i % 8), 4 + (i % 20))).toISOString(),
		createdAt: now
	}));
	const gifts = Array.from({ length: 26 }, (_, i) => ({
		id: uid(offset + 100 + i),
		contactId: contacts[i % contacts.length].id,
		amountMinor: [2500, 5000, 10000, 25000, 7500, 15000][i % 6],
		currency: 'USD',
		kind: i % 4 === 0 ? 'recurring' : 'one_time',
		status: 'recorded',
		campaignId: uid(offset + 201 + (i % 3)),
		occurredAt: new Date(Date.UTC(2026, 4 + (i % 6), 5 + (i % 22))).toISOString(),
		designation: ['Youth programs', 'Community garden', 'General fund'][i % 3]
	}));
	const campaigns = [
		{
			id: uid(offset + 201),
			name: 'A Place to Grow',
			goalMinor: 7500000,
			raisedMinor: 2845000,
			currency: 'USD',
			status: 'active',
			endsAt: '2026-12-31',
			color: 'sage'
		},
		{
			id: uid(offset + 202),
			name: 'Neighbors at the Table',
			goalMinor: 5000000,
			raisedMinor: 1920000,
			currency: 'USD',
			status: 'active',
			endsAt: '2026-11-30',
			color: 'coral'
		},
		{
			id: uid(offset + 203),
			name: 'Future Fund',
			goalMinor: 12000000,
			raisedMinor: 8150000,
			currency: 'USD',
			status: 'active',
			endsAt: '2027-03-15',
			color: 'blue'
		}
	];
	const prospects = [
		{
			id: uid(offset + 301),
			name: 'Cedar Grove Foundation',
			stage: 'qualified',
			score: 82,
			evidence: [
				{
					sourceName: 'Synthetic sample grant record',
					sourceUrl: 'https://example.test/record',
					observedAt: '2026-06-01',
					confidence: 'high'
				}
			],
			reason: 'Mission-aligned local grants; sample data'
		},
		{
			id: uid(offset + 302),
			name: 'Jordan Ellis',
			stage: 'discovered',
			score: 61,
			evidence: [
				{
					sourceName: 'Synthetic sample board listing',
					observedAt: '2026-04-15',
					confidence: 'possible'
				}
			],
			reason: 'Shared organization affiliation; not a verified personal connection'
		}
	];
	const tasks = [
		{
			id: uid(offset + 401),
			title: 'Send a thank-you note to Maya',
			contactId: contacts[0].id,
			dueAt: '2026-10-24T17:00:00.000Z',
			priority: 'high',
			status: 'open'
		},
		{
			id: uid(offset + 402),
			title: 'Prepare garden campaign update',
			dueAt: '2026-10-27T17:00:00.000Z',
			priority: 'normal',
			status: 'open'
		},
		{
			id: uid(offset + 403),
			title: 'Ask Nina about volunteer orientation',
			contactId: contacts[2].id,
			dueAt: '2026-10-29T17:00:00.000Z',
			priority: 'normal',
			status: 'open'
		}
	];
	return {
		tenant: {
			id: uid(offset),
			slug,
			name,
			currency: 'USD',
			timeZone: 'America/Phoenix',
			demo: true
		},
		user: { id: `demo:${slug}`, email: 'jamie@example.test', name: 'Jamie Rivera', role: 'owner' },
		memberships: [
			{
				id: uid(1000),
				slug: 'riverstone',
				name: 'Riverstone Community Fund',
				currency: 'USD',
				timeZone: 'America/Phoenix',
				role: 'owner'
			},
			{
				id: uid(2000),
				slug: 'harbor',
				name: 'Harbor House Foundation',
				currency: 'USD',
				timeZone: 'America/Phoenix',
				role: 'owner'
			}
		],
		contacts,
		gifts,
		campaigns,
		tasks,
		prospects,
		introductions: [
			{
				id: uid(offset + 501),
				prospectId: prospects[1].id,
				contactId: contacts[6].id,
				stage: 'internal_review',
				nextStep: 'Confirm whether they know each other personally',
				synthetic: true
			}
		],
		emails: [
			{
				id: uid(offset + 601),
				subject: 'A small note of thanks',
				body: 'Hi {{preferredName}},\n\nYour generosity helps neighbors thrive. This is a review-only sample draft.',
				status: 'draft',
				consent: true,
				synthetic: true
			}
		],
		automations: [
			{
				id: uid(offset + 701),
				name: 'New gift thank-you (simulation)',
				status: 'draft',
				trigger: 'gift.received',
				actions: ['create thank-you task'],
				simulationOnly: true
			}
		],
		activities: [
			{
				id: uid(offset + 801),
				contactId: contacts[0].id,
				kind: 'note',
				summary: 'Enjoyed the community garden open house. (Synthetic sample)',
				occurredAt: now
			}
		],
		relationships: [
			{
				id: uid(offset + 901),
				fromId: contacts[6].id,
				toId: prospects[1].id,
				kind: 'serves_on_board',
				evidence: 'Synthetic sample board listing',
				confidence: 'possible',
				verified: false
			}
		],
		organizations: [
			{
				id: uid(offset + 1001),
				name: 'Cedar Grove Foundation',
				type: 'Foundation',
				website: 'https://example.test/cedar-grove',
				synthetic: true
			}
		],
		households: [
			{
				id: uid(offset + 1002),
				name: 'The Chen household',
				memberIds: [contacts[0].id],
				synthetic: true
			}
		],
		segments: [
			{
				id: uid(offset + 1003),
				name: 'Monthly supporters',
				rules: [{ field: 'cadence', operator: 'equals', value: 'monthly' }],
				synthetic: true
			}
		],
		events: [
			{
				id: uid(offset + 1004),
				name: 'Community garden open house',
				date: '2026-11-14',
				capacity: 80,
				description: 'Synthetic demo event',
				synthetic: true
			}
		],
		settings: {
			organizationName: name,
			currency: 'USD',
			timeZone: 'America/Phoenix',
			demo: true,
			emailSendingEnabled: false,
			paymentsEnabled: false,
			paidResearchEnabled: false,
			aiStatus: 'unavailable until configured'
		}
	};
}

export const demoWorkspaces: Record<string, Workspace> = {
	riverstone: makeWorkspace('riverstone', 'Riverstone Community Fund', 1000),
	harbor: makeWorkspace('harbor', 'Harbor House Foundation', 2000)
};

export const emptyWorkspace = (slug: string): Workspace =>
	demoWorkspaces[slug]
		? structuredClone(demoWorkspaces[slug])
		: (() => {
				throw new Error('Unknown tenant');
			})();
export const collectionNames: Resource[] = [
	'contacts',
	'gifts',
	'campaigns',
	'tasks',
	'prospects',
	'introductions',
	'emails',
	'automations',
	'activities',
	'relationships',
	'organizations',
	'households',
	'segments',
	'events',
	'settings'
];
