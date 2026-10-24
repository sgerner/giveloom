import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { env } from '$env/dynamic/private';
import { demoWorkspaces } from './demo-data';
import { assertRoleCanMutate, type Resource, type Workspace } from './domain';

type DemoDb = {
	tenants: Record<string, Workspace>;
	audit: Record<string, unknown>[];
	outbox: Record<string, unknown>[];
	contactMerges?: Record<string, Record<string, any>[]>;
};
const dataFile = env.DEMO_DATA_PATH || '.data/giveloom-demo.json';
let pending: Promise<unknown> = Promise.resolve();
let cached: DemoDb | undefined;

async function getDb(): Promise<DemoDb> {
	if (cached) return cached;
	let upgraded = false;
	try {
		cached = JSON.parse(await readFile(dataFile, 'utf8')) as DemoDb;
		if (!cached.contactMerges) {
			cached.contactMerges = {};
			upgraded = true;
		}
		for (const [slug, defaults] of Object.entries(demoWorkspaces)) {
			const workspace = cached.tenants?.[slug];
			if (!workspace) {
				cached.tenants ||= {};
				cached.tenants[slug] = structuredClone(defaults);
				upgraded = true;
				continue;
			}
			for (const key of [
				'user',
				'memberships',
				'organizations',
				'households',
				'segments',
				'events'
			] as const) {
				if ((workspace as unknown as Record<string, unknown>)[key] === undefined) {
					(workspace as unknown as Record<string, unknown>)[key] = structuredClone(defaults[key]);
					upgraded = true;
				}
			}
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
			throw new Error('Demo data file could not be read; refusing to replace it.');
		cached = { tenants: structuredClone(demoWorkspaces), audit: [], outbox: [], contactMerges: {} };
		await persist(cached);
	}
	if (upgraded) await persist(cached);
	return cached;
}
async function persist(db: DemoDb) {
	await mkdir(dirname(dataFile), { recursive: true });
	const temp = `${dataFile}.${process.pid}.tmp`;
	await writeFile(temp, JSON.stringify(db, null, 2), { mode: 0o600 });
	await rename(temp, dataFile);
}
function serialized<T>(fn: () => Promise<T>): Promise<T> {
	const result = pending.then(fn, fn);
	pending = result.then(
		() => undefined,
		() => undefined
	);
	return result;
}
export async function listTenants() {
	const db = await getDb();
	return Object.values(db.tenants).map((w) => w.tenant);
}
export async function getWorkspace(slug: string): Promise<Workspace | null> {
	const db = await getDb();
	const w = db.tenants[slug];
	if (!w) return null;
	w.contactAliases = (db.contactMerges?.[slug] || [])
		.filter((merge) => !merge.undoneAt)
		.map((merge) => ({
			id: merge.sourceId,
			name: merge.sourceBefore.name,
			mergedInto: merge.targetId
		}));
	return structuredClone(w);
}
function demoMergePermission(role: string) {
	if (!['owner', 'admin'].includes(role))
		throw Object.assign(new Error('Contact merge requires an owner or admin role.'), {
			status: 403
		});
}
function demoMergeRefs(workspace: Workspace, sourceId: string) {
	return {
		tasks: workspace.tasks
			.filter((row) => row.contactId === sourceId)
			.map((row) => ({ id: row.id, contactId: row.contactId })),
		activities: workspace.activities
			.filter((row) => row.contactId === sourceId)
			.map((row) => ({ id: row.id, contactId: row.contactId })),
		introductions: workspace.introductions
			.filter((row) => row.contactId === sourceId)
			.map((row) => ({ id: row.id, contactId: row.contactId })),
		emails: workspace.emails
			.filter((row) => row.contactId === sourceId)
			.map((row) => ({ id: row.id, contactId: row.contactId })),
		households: workspace.households
			.filter((row) => (row.memberIds as string[]).includes(sourceId))
			.map((row) => ({ id: row.id, memberIds: structuredClone(row.memberIds) })),
		relationships: workspace.relationships
			.filter((row) => row.fromId === sourceId || row.toId === sourceId)
			.map((row) => ({ id: row.id, fromId: row.fromId, toId: row.toId }))
	};
}
export async function previewDemoContactMerge(
	slug: string,
	sourceId: string,
	targetId: string,
	role: string
) {
	demoMergePermission(role);
	const workspace = await getWorkspace(slug);
	if (!workspace) throw Object.assign(new Error('Tenant not found.'), { status: 404 });
	if (sourceId === targetId)
		throw Object.assign(new Error('Choose two different contacts.'), { status: 422 });
	const source = workspace.contacts.find((row) => row.id === sourceId),
		target = workspace.contacts.find((row) => row.id === targetId);
	if (!source || !target)
		throw Object.assign(new Error('Both contacts must exist in the active workspace.'), {
			status: 404
		});
	if (source.archived || source.mergedInto || target.archived || target.mergedInto)
		throw Object.assign(new Error('Archived or already-merged contacts cannot be merged.'), {
			status: 409
		});
	const refs = demoMergeRefs(workspace, sourceId);
	return {
		source: { id: source.id, name: source.name, email: source.email },
		target: { id: target.id, name: target.name, email: target.email },
		conflicts: ['name', 'email', 'stage']
			.filter(
				(key) =>
					source[key] &&
					target[key] &&
					String(source[key]).toLowerCase() !== String(target[key]).toLowerCase()
			)
			.map((field) => ({ field, source: source[field], target: target[field] })),
		referenceCounts: {
			...Object.fromEntries(Object.entries(refs).map(([key, value]) => [key, value.length])),
			gifts: workspace.gifts.filter((gift) => gift.contactId === sourceId).length
		},
		ledgerPolicy: 'Gift events remain linked to the original contact and are never rewritten.'
	};
}
export async function mergeDemoContacts(
	slug: string,
	sourceId: string,
	targetId: string,
	role: string
) {
	return serialized(async () => {
		demoMergePermission(role);
		const db = await getDb();
		const workspace = db.tenants[slug];
		if (!workspace) throw Object.assign(new Error('Tenant not found.'), { status: 404 });
		const source = workspace.contacts.find((row) => row.id === sourceId),
			target = workspace.contacts.find((row) => row.id === targetId);
		if (sourceId === targetId || !source || !target)
			throw Object.assign(new Error('Choose two existing contacts.'), { status: 422 });
		if (source.archived || source.mergedInto || target.archived || target.mergedInto)
			throw Object.assign(new Error('Archived or already-merged contacts cannot be merged.'), {
				status: 409
			});
		const references = demoMergeRefs(workspace, sourceId),
			sourceBefore = structuredClone(source),
			targetBefore = structuredClone(target);
		for (const list of [
			workspace.tasks,
			workspace.activities,
			workspace.introductions,
			workspace.emails
		])
			for (const row of list) if (row.contactId === sourceId) row.contactId = targetId;
		for (const household of workspace.households)
			if ((household.memberIds as string[]).includes(sourceId))
				household.memberIds = [
					...new Set(
						(household.memberIds as string[]).map((id) => (id === sourceId ? targetId : id))
					)
				];
		for (const relationship of workspace.relationships) {
			if (relationship.fromId === sourceId) relationship.fromId = targetId;
			if (relationship.toId === sourceId) relationship.toId = targetId;
		}
		target.email ||= source.email;
		target.tags = [
			...new Set([...((target.tags as string[]) || []), ...((source.tags as string[]) || [])])
		];
		target.updatedAt = new Date().toISOString();
		source.email = '';
		source.archived = true;
		source.mergedInto = targetId;
		source.updatedAt = new Date().toISOString();
		const referencesAfter = {
			tasks: references.tasks.map((row) => ({ ...row, contactId: targetId })),
			activities: references.activities.map((row) => ({ ...row, contactId: targetId })),
			introductions: references.introductions.map((row) => ({ ...row, contactId: targetId })),
			emails: references.emails.map((row) => ({ ...row, contactId: targetId })),
			households: references.households.map((row) => ({
				...row,
				memberIds: [
					...new Set((row.memberIds as string[]).map((id) => (id === sourceId ? targetId : id)))
				]
			})),
			relationships: references.relationships.map((row) => ({
				...row,
				fromId: row.fromId === sourceId ? targetId : row.fromId,
				toId: row.toId === sourceId ? targetId : row.toId
			}))
		};
		const mergeId = randomUUID(),
			merge = {
				id: mergeId,
				sourceId,
				targetId,
				sourceBefore,
				targetBefore,
				targetAfter: structuredClone(target),
				references,
				referencesAfter,
				undoneAt: null,
				createdAt: new Date().toISOString()
			};
		db.contactMerges ||= {};
		(db.contactMerges[slug] ||= []).push(merge);
		db.audit.push({
			id: randomUUID(),
			tenantId: workspace.tenant.id,
			actor: `demo:${slug}`,
			action: 'contact.merged',
			resource: 'contacts',
			recordId: sourceId,
			details: { targetId, mergeId },
			at: new Date().toISOString()
		});
		db.outbox.push({
			id: randomUUID(),
			tenantId: workspace.tenant.id,
			eventType: 'contact.merged',
			payload: { sourceId, targetId, mergeId },
			idempotencyKey: `contact.merged:${workspace.tenant.id}:${mergeId}`,
			createdAt: new Date().toISOString(),
			processedAt: null,
			attempts: 0,
			lastError: null
		});
		await persist(db);
		return { mergeId, sourceId, targetId, mergedAt: merge.createdAt };
	});
}
export async function undoDemoContactMerge(slug: string, mergeId: string, role: string) {
	return serialized(async () => {
		demoMergePermission(role);
		const db = await getDb();
		const workspace = db.tenants[slug];
		if (!workspace) throw Object.assign(new Error('Tenant not found.'), { status: 404 });
		const merge = (db.contactMerges?.[slug] || []).find((row) => row.id === mergeId);
		if (!merge)
			throw Object.assign(new Error('Merge history was not found in the active workspace.'), {
				status: 404
			});
		if (merge.undoneAt)
			throw Object.assign(new Error('This contact merge has already been undone.'), {
				status: 409
			});
		const source = workspace.contacts.find((row) => row.id === merge.sourceId),
			target = workspace.contacts.find((row) => row.id === merge.targetId);
		if (!source || !target || source.mergedInto !== merge.targetId)
			throw Object.assign(new Error('The merged contact state has changed since this operation.'), {
				status: 409
			});
		if (JSON.stringify(target) !== JSON.stringify(merge.targetAfter))
			throw Object.assign(
				new Error('The target contact changed after this merge; undo is unsafe.'),
				{ status: 409 }
			);
		for (const [listName, rows] of Object.entries(merge.referencesAfter) as Array<
			[string, Array<Record<string, unknown>>]
		>)
			for (const expected of rows) {
				const list = workspace[
					listName as
						'tasks' | 'activities' | 'introductions' | 'emails' | 'households' | 'relationships'
				] as Record<string, unknown>[];
				const row = list.find((item) => item.id === expected.id);
				if (!row)
					throw Object.assign(
						new Error('A related record changed after this merge; undo is unsafe.'),
						{ status: 409 }
					);
				const keys =
					listName === 'households'
						? ['memberIds']
						: listName === 'relationships'
							? ['fromId', 'toId']
							: ['contactId'];
				if (keys.some((key) => JSON.stringify(row[key]) !== JSON.stringify(expected[key])))
					throw Object.assign(
						new Error('A related record changed after this merge; undo is unsafe.'),
						{ status: 409 }
					);
			}
		Object.assign(source, structuredClone(merge.sourceBefore));
		Object.assign(target, structuredClone(merge.targetBefore));
		for (const [listName, rows] of Object.entries(merge.references) as Array<
			[string, Array<Record<string, unknown>>]
		>)
			for (const snapshot of rows) {
				const list = workspace[
					listName as
						'tasks' | 'activities' | 'introductions' | 'emails' | 'households' | 'relationships'
				] as Record<string, unknown>[];
				const row = list.find((item) => item.id === snapshot.id);
				if (row) Object.assign(row, structuredClone(snapshot));
			}
		merge.undoneAt = new Date().toISOString();
		db.audit.push({
			id: randomUUID(),
			tenantId: workspace.tenant.id,
			actor: `demo:${slug}`,
			action: 'contact.merge_undone',
			resource: 'contacts',
			recordId: merge.sourceId,
			details: { targetId: merge.targetId, mergeId },
			at: merge.undoneAt
		});
		db.outbox.push({
			id: randomUUID(),
			tenantId: workspace.tenant.id,
			eventType: 'contact.merge_undone',
			payload: { sourceId: merge.sourceId, targetId: merge.targetId, mergeId },
			idempotencyKey: `contact.merge_undone:${workspace.tenant.id}:${mergeId}`,
			createdAt: merge.undoneAt,
			processedAt: null,
			attempts: 0,
			lastError: null
		});
		await persist(db);
		return { mergeId, sourceId: merge.sourceId, targetId: merge.targetId, undone: true };
	});
}
export async function recordDemoRead(slug: string, resource: string) {
	return serialized(async () => {
		const db = await getDb();
		const workspace = db.tenants[slug];
		if (!workspace) return;
		db.audit.push({
			id: randomUUID(),
			tenantId: workspace.tenant.id,
			actor: `demo:${slug}`,
			action: `${resource}.read`,
			resource,
			at: new Date().toISOString()
		});
		await persist(db);
	});
}
export async function readDemoAudit(slug: string) {
	const db = await getDb();
	if (!db.tenants[slug]) throw Object.assign(new Error('Tenant not found.'), { status: 404 });
	return structuredClone(
		db.audit
			.filter((item) => item.tenantId === db.tenants[slug].tenant.id)
			.slice(-200)
			.reverse()
	);
}
export async function importContactsDemo(slug: string, contacts: Record<string, unknown>[]) {
	return serialized(async () => {
		const db = await getDb();
		const workspace = db.tenants[slug];
		if (!workspace) throw new Error('Tenant not found');
		const emails = new Set(
			workspace.contacts.map((row) => String(row.email || '').toLowerCase()).filter(Boolean)
		);
		for (const contact of contacts) {
			const email = String(contact.email || '').toLowerCase();
			if (email && emails.has(email))
				throw new Error(
					'Contact list changed after preview; no records were imported. Review duplicate rows and retry.'
				);
			if (email) emails.add(email);
		}
		const created = contacts.map((contact) => ({
			...contact,
			id: randomUUID(),
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString()
		}));
		workspace.contacts.push(...created);
		for (const item of created) {
			db.audit.push({
				id: randomUUID(),
				tenantId: workspace.tenant.id,
				actor: `demo:${slug}`,
				action: 'contact.imported',
				resource: 'contacts',
				recordId: item.id,
				at: new Date().toISOString()
			});
			db.outbox.push({
				id: randomUUID(),
				tenantId: workspace.tenant.id,
				eventType: 'contact.created',
				payload: { resource: 'contacts', recordId: item.id },
				idempotencyKey: `contact.created:${item.id}`,
				createdAt: new Date().toISOString(),
				processedAt: null,
				attempts: 0,
				lastError: null
			});
		}
		await persist(db);
		return created;
	});
}
export async function applyMutation(
	slug: string,
	resource: Resource,
	input: Record<string, unknown>,
	action: 'create' | 'update' | 'archive' | 'simulate' = 'create',
	role = 'owner'
) {
	return serialized(async () => {
		const db = await getDb();
		const workspace = db.tenants[slug];
		if (!workspace) throw new Error('Tenant not found');
		assertRoleCanMutate(role, resource, action);
		const hasId = (list: Record<string, unknown>[], id: unknown) =>
			list.some((row) => row.id === id);
		const requireReference = (field: string, list: Record<string, unknown>[], id: unknown) => {
			if (id && !hasId(list, id))
				throw Object.assign(new Error(`${field} must reference a record in the active tenant.`), {
					status: 422
				});
		};
		if (['gifts', 'tasks', 'activities', 'introductions', 'emails'].includes(resource))
			requireReference('contactId', workspace.contacts, input.contactId);
		if (resource === 'gifts') {
			requireReference('campaignId', workspace.campaigns, input.campaignId);
			requireReference('correctionOf', workspace.gifts, input.correctionOf);
		}
		if (resource === 'introductions')
			requireReference('prospectId', workspace.prospects, input.prospectId);
		if (resource === 'relationships') {
			const entities = [
				...workspace.contacts,
				...workspace.prospects,
				...workspace.introductions,
				...workspace.campaigns
			];
			requireReference('fromId', entities, input.fromId);
			requireReference('toId', entities, input.toId);
		}
		if (resource === 'households') {
			for (const memberId of (input.memberIds as unknown[]) || [])
				requireReference(
					'memberIds',
					workspace.contacts.filter((row) => !row.archived),
					memberId
				);
		}
		if (resource === 'contacts' && (action === 'update' || action === 'archive')) {
			const existing = workspace.contacts.find((row) => row.id === input.id);
			if (!existing || existing.archived || existing.mergedInto)
				throw Object.assign(
					new Error('Contact is archived, merged, or missing in the active tenant.'),
					{ status: 404 }
				);
		}
		if (resource === 'automations' && action === 'simulate') {
			if (input.id && !workspace.automations.some((automation) => automation.id === input.id))
				throw Object.assign(new Error('Automation not found in the active tenant.'), {
					status: 404
				});
			return {
				item: {
					...input,
					simulated: true,
					wouldSend: false,
					result: 'Simulation only; no messages or paid services were invoked.'
				},
				workspace: structuredClone(workspace)
			};
		}
		let item: Record<string, unknown>;
		if (resource === 'settings') {
			workspace.settings = {
				...workspace.settings,
				...input,
				emailSendingEnabled: false,
				paymentsEnabled: false,
				paidResearchEnabled: false
			};
			item = workspace.settings;
		} else if (action === 'update' || action === 'archive') {
			const coll = workspace[resource];
			const index = coll.findIndex((row) => row.id === input.id);
			if (index < 0) throw new Error('Record not found');
			if (resource === 'contacts' && (coll[index].archived || coll[index].mergedInto))
				throw Object.assign(new Error('Contact is archived or merged and cannot be edited.'), {
					status: 404
				});
			item = {
				...coll[index],
				...input,
				...(action === 'archive' ? { archived: true } : {}),
				updatedAt: new Date().toISOString()
			};
			coll[index] = item;
		} else {
			const coll = workspace[resource];
			item = {
				...input,
				id: input.id || randomUUID(),
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString()
			};
			coll.push(item);
		}
		const eventType =
			resource === 'gifts'
				? 'gift.recorded'
				: `${resource}.${action === 'update' ? 'updated' : 'created'}`;
		db.audit.push({
			id: randomUUID(),
			tenantId: workspace.tenant.id,
			actor: 'demo-user',
			action: eventType,
			resource,
			recordId: item.id,
			at: new Date().toISOString()
		});
		db.outbox.push({
			id: randomUUID(),
			tenantId: workspace.tenant.id,
			eventType,
			payload: { resource, recordId: item.id },
			idempotencyKey: `${eventType}:${item.id}`,
			createdAt: new Date().toISOString(),
			processedAt: null,
			attempts: 0,
			lastError: null
		});
		await persist(db);
		return { item: structuredClone(item), workspace: structuredClone(workspace) };
	});
}
export function dbConfigured() {
	return Boolean(env.DATABASE_URL);
}
export function demoModeAvailable() {
	return process.env.NODE_ENV !== 'production';
}
