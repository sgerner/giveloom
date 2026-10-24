import { z } from 'zod';
import { createHash, randomUUID } from 'node:crypto';
import Papa from 'papaparse';
import { env } from '$env/dynamic/private';
import {
	tenantTransaction,
	demoAuthorization,
	ServiceError,
	assertContact,
	serviceAudit,
	serviceEvent,
	editors,
	type TenantSession
} from './tenant-service';
import { demoRead, demoWrite } from './demo-extensions';
import { redactWorkspaceRecord, safeMinorUnits } from './domain';
import { getWorkspace, applyMutation, importContactsDemo } from './store';
import { analyzeContactCsv } from './csv';
const uuid = z.string().uuid();
const text = z.string().trim().min(1).max(500);
const writeRoles = [...editors, 'marketer', 'finance', 'finance_manager'];
export const crmCommandSchema = z.discriminatedUnion('action', [
	z.object({
		action: z.literal('method'),
		contactId: uuid,
		kind: z.enum(['email', 'phone']),
		value: text,
		preferred: z.boolean().default(false)
	}),
	z.object({
		action: z.literal('address'),
		contactId: uuid,
		label: z.string().max(40).default('home'),
		line1: text,
		line2: z.string().max(200).default(''),
		city: z.string().max(100).default(''),
		region: z.string().max(100).default(''),
		postalCode: z.string().max(30).default(''),
		country: z.string().length(2).default('US'),
		preferred: z.boolean().default(false)
	}),
	z.object({
		action: z.literal('consent'),
		contactId: uuid,
		channel: z.enum(['email', 'phone', 'sms', 'post']),
		purpose: z.enum(['marketing', 'receipts', 'research']),
		status: z.enum(['granted', 'withdrawn', 'unknown']),
		source: text,
		lawfulBasis: z
			.enum(['consent', 'legitimate_interest', 'contract', 'legal_obligation'])
			.default('consent')
	}),
	z.object({
		action: z.literal('field'),
		name: z.string().trim().min(1).max(80),
		kind: z.enum(['text', 'number', 'date', 'boolean', 'choice']),
		choices: z.array(z.string().max(100)).max(50).default([]),
		sensitive: z.boolean().default(false),
		required: z.boolean().default(false)
	}),
	z.object({ action: z.literal('value'), contactId: uuid, fieldId: uuid, value: z.unknown() }),
	z.object({
		action: z.literal('note'),
		contactId: uuid,
		body: z.string().trim().min(1).max(10000),
		sensitive: z.boolean().default(false)
	}),
	z.object({
		action: z.literal('bulk'),
		contactIds: z.array(uuid).min(1).max(500),
		operation: z.enum(['tag', 'stage', 'archive', 'assign']),
		value: z.string().max(150).optional(),
		ownerId: uuid.optional(),
		confirmed: z.literal(true)
	}),
	z.object({
		action: z.literal('filter'),
		name: z.string().trim().min(1).max(100),
		definition: z.record(z.string(), z.unknown())
	}),
	z.object({
		action: z.literal('privacy'),
		contactId: uuid,
		operation: z.enum(['export', 'anonymize']),
		confirmed: z.literal(true),
		reason: text
	}),
	z.object({ action: z.literal('rollback_import'), batchId: uuid, confirmed: z.literal(true) })
]);
export function normalizeMethod(kind: string, value: string) {
	if (kind === 'email') return z.string().email().parse(value.trim().toLowerCase());
	const normalized = value.replace(/[^0-9+]/g, '');
	if (!/^\+?[0-9]{7,15}$/.test(normalized))
		throw new ServiceError('Enter a valid phone number with country code.');
	return normalized;
}
function checkField(field: { kind: string; choices?: unknown }, value: unknown) {
	const choices = Array.isArray(field.choices) ? field.choices : [];
	const schema =
		field.kind === 'number'
			? z.number().finite()
			: field.kind === 'boolean'
				? z.boolean()
				: field.kind === 'date'
					? z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
					: field.kind === 'choice'
						? z.string().refine((v) => choices.includes(v))
						: z.string().max(5000);
	return schema.parse(value);
}
const contactReaders = [
	'owner',
	'admin',
	'finance',
	'finance_manager',
	'fundraising_manager',
	'fundraiser',
	'marketer',
	'analyst'
];
const restricted = (role: string) => ['owner', 'admin'].includes(role);
export async function crmSnapshot(session: TenantSession, contactId?: string) {
	if (session.demo) {
		const w = await demoAuthorization(session, contactReaders);
		if (contactId && !w.contacts.some((c) => c.id === contactId))
			throw new ServiceError('Contact not found.', 404);
		const resources = [
			'methods',
			'addresses',
			'consents',
			'fields',
			'values',
			'notes',
			'filters',
			'importBatches'
		];
		const out: Record<string, any> = {};
		for (const resource of resources) {
			const rows = await demoRead(session, 'crm.' + resource);
			out[resource] = rows.filter((r) => !contactId || !r.contactId || r.contactId === contactId);
		}
		return out;
	}
	return tenantTransaction(session, contactReaders, async (client, t) => {
		if (contactId) await assertContact(client, t.id, contactId);
		const param = contactId ? [t.id, contactId] : [t.id];
		const where = contactId ? ' AND contact_id=$2' : ' AND false';
		const [methods, addresses, consents, fields, values, notes, filters, batches] =
			await Promise.all([
				client.query(
					'SELECT id,contact_id AS "contactId",kind,value,preferred FROM contact_methods WHERE tenant_id=$1' +
						where,
					param
				),
				client.query(
					'SELECT id,contact_id AS "contactId",label,line1,line2,city,region,postal_code AS "postalCode",country,preferred FROM addresses WHERE tenant_id=$1' +
						where,
					param
				),
				client.query(
					'SELECT id,contact_id AS "contactId",channel,purpose,status,source,lawful_basis AS "lawfulBasis",recorded_at AS "recordedAt" FROM consents WHERE tenant_id=$1' +
						where +
						' ORDER BY recorded_at DESC',
					param
				),
				client.query(
					'SELECT id,name,kind,choices,sensitive,required FROM custom_field_definitions WHERE tenant_id=$1 AND ($2 OR NOT sensitive)',
					[t.id, restricted(t.role)]
				),
				client.query(
					'SELECT v.contact_id AS "contactId",v.field_id AS "fieldId",v.value FROM custom_field_values v JOIN custom_field_definitions f ON f.tenant_id=v.tenant_id AND f.id=v.field_id WHERE v.tenant_id=$1' +
						(contactId ? ' AND v.contact_id=$2' : ' AND false') +
						' AND (' +
						(contactId ? '$3' : '$2') +
						' OR NOT f.sensitive)',
					[...param, restricted(t.role)]
				),
				client.query(
					'SELECT id,contact_id AS "contactId",body,sensitive,created_at AS "createdAt" FROM notes WHERE tenant_id=$1' +
						where +
						' AND (' +
						(contactId ? '$3' : '$2') +
						' OR NOT sensitive) ORDER BY created_at DESC',
					[...param, restricted(t.role)]
				),
				client.query(
					'SELECT id,name,definition FROM saved_filters WHERE tenant_id=$1 AND user_id=$2',
					[t.id, session.userId]
				),
				client.query(
					'SELECT id,created_at AS "createdAt",cardinality(contact_ids) AS count,rolled_back_at AS "rolledBackAt" FROM contact_import_batches WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 50',
					[t.id]
				)
			]);
		await serviceAudit(client, t.id, session.userId, 'crm.read', 'contacts', contactId);
		return {
			methods: methods.rows,
			addresses: addresses.rows,
			consents: consents.rows,
			fields: fields.rows,
			values: values.rows,
			notes: notes.rows,
			filters: filters.rows,
			importBatches: batches.rows
		};
	});
}
export async function crmCommand(session: TenantSession, input: unknown) {
	const command = crmCommandSchema.parse(input);
	const admin = ['field', 'privacy', 'rollback_import'].includes(command.action);
	if (session.demo) {
		const w = await demoAuthorization(session, admin ? ['owner', 'admin'] : writeRoles);
		if ('contactId' in command && !w.contacts.some((c) => c.id === command.contactId))
			throw new ServiceError('Contact not found.', 404);
		if (command.action === 'bulk') {
			for (const id of command.contactIds) {
				const c = w.contacts.find((c) => c.id === id);
				if (!c) throw new ServiceError('A selected contact is outside your workspace.', 404);
				await applyMutation(
					session.tenantSlug,
					'contacts',
					{
						...c,
						...(command.operation === 'tag'
							? { tags: [...new Set([...((c.tags as string[]) || []), command.value || ''])] }
							: command.operation === 'stage'
								? { stage: command.value }
								: command.operation === 'assign'
									? { ownerId: command.ownerId }
									: {}),
						id
					},
					command.operation === 'archive' ? 'archive' : 'update'
				);
			}
			return { updated: command.contactIds.length };
		}
		if (command.action === 'privacy') {
			if (command.operation === 'export')
				return {
					contact: w.contacts.find((c) => c.id === command.contactId),
					profile: await crmSnapshot(session, command.contactId),
					gifts: w.gifts.filter((g) => g.contactId === command.contactId)
				};
			const c = w.contacts.find((c) => c.id === command.contactId)!;
			await applyMutation(
				session.tenantSlug,
				'contacts',
				{ ...c, name: 'Anonymized donor', email: '', phone: '', tags: [], consent: false },
				'update'
			);
			return { anonymized: true, retained: 'Immutable financial records retained.' };
		}
		return demoWrite(session, admin ? ['owner', 'admin'] : writeRoles, (records) => {
			const resource =
				'crm.' +
				(
					{
						method: 'methods',
						address: 'addresses',
						consent: 'consents',
						field: 'fields',
						value: 'values',
						note: 'notes',
						filter: 'filters',
						rollback_import: 'importBatches'
					} as Record<string, string>
				)[command.action];
			records[resource] ||= [];
			if (command.action === 'rollback_import')
				throw new ServiceError(
					'Review and archive imported demo contacts using bulk actions; demo batches are synthetic.',
					409
				);
			if (command.action === 'value') {
				const field = records['crm.fields']?.find((f) => f.id === command.fieldId);
				if (!field) throw new ServiceError('Field not found.', 404);
				checkField(field as any, command.value);
				const i = records[resource].findIndex(
					(r) => r.contactId === command.contactId && r.fieldId === command.fieldId
				);
				if (i >= 0) records[resource].splice(i, 1);
			}
			const row = { ...command, id: randomUUID(), createdAt: new Date().toISOString() };
			if (command.action === 'method') normalizeMethod(command.kind, command.value);
			records[resource].push(row);
			return row;
		});
	}
	return tenantTransaction(session, admin ? ['owner', 'admin'] : writeRoles, async (client, t) => {
		if ('contactId' in command) await assertContact(client, t.id, command.contactId);
		let result: any;
		switch (command.action) {
			case 'method': {
				const normalized = normalizeMethod(command.kind, command.value);
				if (command.preferred)
					await client.query(
						'UPDATE contact_methods SET preferred=false WHERE tenant_id=$1 AND contact_id=$2 AND kind=$3',
						[t.id, command.contactId, command.kind]
					);
				result = (
					await client.query(
						'INSERT INTO contact_methods(tenant_id,contact_id,kind,value,normalized_value,preferred) VALUES($1,$2,$3,$4,$5,$6) RETURNING id',
						[t.id, command.contactId, command.kind, command.value, normalized, command.preferred]
					)
				).rows[0];
				break;
			}
			case 'address': {
				if (command.preferred)
					await client.query(
						'UPDATE addresses SET preferred=false WHERE tenant_id=$1 AND contact_id=$2',
						[t.id, command.contactId]
					);
				result = (
					await client.query(
						'INSERT INTO addresses(tenant_id,contact_id,label,line1,line2,city,region,postal_code,country,preferred) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id',
						[
							t.id,
							command.contactId,
							command.label,
							command.line1,
							command.line2,
							command.city,
							command.region,
							command.postalCode,
							command.country.toUpperCase(),
							command.preferred
						]
					)
				).rows[0];
				break;
			}
			case 'consent': {
				result = (
					await client.query(
						'INSERT INTO consents(tenant_id,contact_id,channel,purpose,status,source,lawful_basis,actor_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id',
						[
							t.id,
							command.contactId,
							command.channel,
							command.purpose,
							command.status,
							command.source,
							command.lawfulBasis,
							session.userId
						]
					)
				).rows[0];
				if (command.channel === 'email' && command.purpose === 'marketing') {
					await client.query(
						"UPDATE contacts SET data=data||jsonb_build_object('consent',$3::boolean,'newsletterOptIn',$3::boolean,'consentSource',$4::text,'consentAt',now()),updated_at=now() WHERE tenant_id=$1 AND id=$2",
						[t.id, command.contactId, command.status === 'granted', command.source]
					);
					const c = await assertContact(client, t.id, command.contactId);
					if (command.status === 'withdrawn' && c.email)
						await client.query(
							"INSERT INTO email_suppressions(tenant_id,email,reason,source,created_by) VALUES($1,lower($2),'unsubscribe',$3,$4) ON CONFLICT(tenant_id,email) DO UPDATE SET reason='unsubscribe',source=EXCLUDED.source",
							[t.id, c.email, command.source, session.userId]
						);
				}
				break;
			}
			case 'field':
				result = (
					await client.query(
						'INSERT INTO custom_field_definitions(tenant_id,name,kind,choices,sensitive,required) VALUES($1,$2,$3,$4,$5,$6) RETURNING id',
						[
							t.id,
							command.name,
							command.kind,
							JSON.stringify(command.choices),
							command.sensitive,
							command.required
						]
					)
				).rows[0];
				break;
			case 'value': {
				const f = await client.query(
					'SELECT kind,choices,sensitive FROM custom_field_definitions WHERE tenant_id=$1 AND id=$2',
					[t.id, command.fieldId]
				);
				if (!f.rowCount) throw new ServiceError('Field definition not found.', 404);
				if (f.rows[0].sensitive && !restricted(t.role))
					throw new ServiceError('This field is restricted.', 403);
				const value = checkField(f.rows[0], command.value);
				await client.query(
					'INSERT INTO custom_field_values(tenant_id,contact_id,field_id,value) VALUES($1,$2,$3,$4) ON CONFLICT(tenant_id,contact_id,field_id) DO UPDATE SET value=EXCLUDED.value,updated_at=now()',
					[t.id, command.contactId, command.fieldId, JSON.stringify(value)]
				);
				result = { saved: true };
				break;
			}
			case 'note':
				if (command.sensitive && !restricted(t.role))
					throw new ServiceError('Sensitive notes require an authorized role.', 403);
				result = (
					await client.query(
						'INSERT INTO notes(tenant_id,contact_id,body,sensitive,actor_id) VALUES($1,$2,$3,$4,$5) RETURNING id',
						[t.id, command.contactId, command.body, command.sensitive, session.userId]
					)
				).rows[0];
				break;
			case 'filter':
				result = (
					await client.query(
						"INSERT INTO saved_filters(tenant_id,user_id,name,resource,definition) VALUES($1,$2,$3,'contacts',$4) RETURNING id",
						[t.id, session.userId, command.name, command.definition]
					)
				).rows[0];
				break;
			case 'bulk': {
				const found = await client.query(
					'SELECT id FROM contacts WHERE tenant_id=$1 AND id=ANY($2::uuid[]) FOR UPDATE',
					[t.id, command.contactIds]
				);
				if (found.rowCount !== new Set(command.contactIds).size)
					throw new ServiceError('Some selected contacts are outside your workspace.', 404);
				if (command.operation === 'assign') {
					const member = await client.query(
						"SELECT 1 FROM memberships WHERE tenant_id=$1 AND user_id=$2 AND status='active'",
						[t.id, command.ownerId]
					);
					if (!member.rowCount)
						throw new ServiceError('Officer must be an active tenant member.', 422);
				}
				if (command.operation === 'tag')
					await client.query(
						'UPDATE contacts SET tags=ARRAY(SELECT DISTINCT unnest(tags||ARRAY[$3]::text[])),updated_at=now() WHERE tenant_id=$1 AND id=ANY($2::uuid[])',
						[t.id, command.contactIds, command.value]
					);
				else if (command.operation === 'stage')
					await client.query(
						'UPDATE contacts SET stage=$3,updated_at=now() WHERE tenant_id=$1 AND id=ANY($2::uuid[])',
						[t.id, command.contactIds, command.value]
					);
				else if (command.operation === 'archive')
					await client.query(
						'UPDATE contacts SET archived_at=now(),updated_at=now() WHERE tenant_id=$1 AND id=ANY($2::uuid[])',
						[t.id, command.contactIds]
					);
				else
					await client.query(
						"UPDATE contacts SET data=data||jsonb_build_object('ownerId',$3::text),updated_at=now() WHERE tenant_id=$1 AND id=ANY($2::uuid[])",
						[t.id, command.contactIds, command.ownerId]
					);
				result = { updated: found.rowCount };
				break;
			}
			case 'privacy': {
				const c = await assertContact(client, t.id, command.contactId);
				if (command.operation === 'export') {
					const gifts = await client.query(
						'SELECT id,amount_minor,currency,kind,status,occurred_at FROM gifts WHERE tenant_id=$1 AND contact_id=$2',
						[t.id, command.contactId]
					);
					const methods = await client.query(
						'SELECT kind,value FROM contact_methods WHERE tenant_id=$1 AND contact_id=$2',
						[t.id, command.contactId]
					);
					result = {
						contact: c,
						methods: methods.rows,
						gifts: gifts.rows,
						retention: 'Financial records remain subject to financial retention requirements.'
					};
				} else {
					if (c.email)
						await client.query(
							"INSERT INTO email_suppressions(tenant_id,email,reason,source,created_by) VALUES($1,lower($2),'manual','privacy-anonymization',$3) ON CONFLICT DO NOTHING",
							[t.id, c.email, session.userId]
						);
					await client.query(
						"UPDATE contacts SET name='Anonymized donor',email=NULL,tags='{}',data=jsonb_build_object('anonymized',true,'consent',false),updated_at=now() WHERE tenant_id=$1 AND id=$2",
						[t.id, command.contactId]
					);
					await client.query('DELETE FROM contact_methods WHERE tenant_id=$1 AND contact_id=$2', [
						t.id,
						command.contactId
					]);
					await client.query('DELETE FROM addresses WHERE tenant_id=$1 AND contact_id=$2', [
						t.id,
						command.contactId
					]);
					await client.query(
						'DELETE FROM custom_field_values WHERE tenant_id=$1 AND contact_id=$2',
						[t.id, command.contactId]
					);
					await client.query(
						"UPDATE notes SET body='[Removed by privacy request]' WHERE tenant_id=$1 AND contact_id=$2",
						[t.id, command.contactId]
					);
					result = {
						anonymized: true,
						retained: 'Gift ledger, receipts and audit retained under financial retention policy.'
					};
				}
				break;
			}
			case 'rollback_import': {
				const batch = await client.query(
					'SELECT * FROM contact_import_batches WHERE tenant_id=$1 AND id=$2 AND rolled_back_at IS NULL FOR UPDATE',
					[t.id, command.batchId]
				);
				if (!batch.rowCount)
					throw new ServiceError('Import batch not found or already rolled back.', 404);
				const ids = batch.rows[0].contact_ids;
				const refs = await client.query(
					'SELECT 1 FROM gifts WHERE tenant_id=$1 AND contact_id=ANY($2::uuid[]) UNION ALL SELECT 1 FROM tasks WHERE tenant_id=$1 AND contact_id=ANY($2::uuid[]) UNION ALL SELECT 1 FROM notes WHERE tenant_id=$1 AND contact_id=ANY($2::uuid[]) UNION ALL SELECT 1 FROM activities WHERE tenant_id=$1 AND contact_id=ANY($2::uuid[]) LIMIT 1',
					[t.id, ids]
				);
				if (refs.rowCount)
					throw new ServiceError(
						'Imported contacts now have linked gifts, tasks, notes or activities. Financial identities cannot be rolled back; archive individually.',
						409
					);
				const current = await client.query(
					'SELECT id,updated_at,created_at FROM contacts WHERE tenant_id=$1 AND id=ANY($2::uuid[]) FOR UPDATE',
					[t.id, ids]
				);
				if (
					current.rows.some(
						(c) => new Date(c.updated_at).getTime() !== new Date(c.created_at).getTime()
					)
				)
					throw new ServiceError(
						'Contacts changed after import. Rollback would discard edits.',
						409
					);
				await client.query(
					'UPDATE contacts SET archived_at=now(),updated_at=now() WHERE tenant_id=$1 AND id=ANY($2::uuid[])',
					[t.id, ids]
				);
				await client.query(
					'UPDATE contact_import_batches SET rolled_back_at=now() WHERE tenant_id=$1 AND id=$2',
					[t.id, command.batchId]
				);
				result = { archived: ids.length };
				break;
			}
		}
		await serviceAudit(
			client,
			t.id,
			session.userId,
			'crm.' + command.action,
			'contacts',
			'contactId' in command ? command.contactId : undefined,
			{ action: command.action }
		);
		return result;
	});
}
export async function contactPage(
	session: TenantSession,
	options: { query?: string; stage?: string; cursor?: string; limit?: number }
) {
	const limit = Math.min(100, Math.max(1, options.limit || 25));
	let cursor: { name: string; id: string } | null = null;
	if (options.cursor) {
		try {
			cursor = JSON.parse(Buffer.from(options.cursor, 'base64url').toString());
			uuid.parse(cursor!.id);
			if (typeof cursor!.name !== 'string') throw new Error();
		} catch {
			throw new ServiceError('Invalid pagination cursor.');
		}
	}
	if (session.demo) {
		const w = await demoAuthorization(session);
		const rows = w.contacts
			.filter(
				(c) =>
					!c.archived &&
					String(c.name + ' ' + c.email)
						.toLowerCase()
						.includes((options.query || '').toLowerCase()) &&
					(!options.stage || c.stage === options.stage)
			)
			.sort(
				(a, b) =>
					String(a.name).localeCompare(String(b.name)) || String(a.id).localeCompare(String(b.id))
			);
		const start = cursor ? rows.findIndex((c) => c.id === cursor!.id) + 1 : 0;
		const items = rows.slice(start, start + limit);
		return {
			items,
			total: rows.length,
			nextCursor:
				start + limit < rows.length && items.length
					? Buffer.from(
							JSON.stringify({ name: items.at(-1)!.name, id: items.at(-1)!.id })
						).toString('base64url')
					: null
		};
	}
	return tenantTransaction(session, null, async (client, t) => {
		const query = (options.query || '').trim().replace(/[%_\\]/g, '\\$&');
		const params = [
			t.id,
			(query ? query : '') + '%',
			options.stage || null,
			cursor?.name || null,
			cursor?.id || null,
			limit + 1
		];
		const result = await client.query(
			'SELECT id,name,email,stage,tags,data,created_at AS "createdAt" FROM contacts WHERE tenant_id=$1 AND archived_at IS NULL AND merged_into IS NULL AND (lower(name) LIKE lower($2) OR lower(email) LIKE lower($2)) AND ($3::text IS NULL OR stage=$3) AND ($4::text IS NULL OR (name,id)>($4,$5::uuid)) ORDER BY name,id LIMIT $6',
			params
		);
		const count = await client.query(
			'SELECT count(*)::int AS count FROM contacts WHERE tenant_id=$1 AND archived_at IS NULL AND merged_into IS NULL AND (lower(name) LIKE lower($2) OR lower(email) LIKE lower($2)) AND ($3::text IS NULL OR stage=$3)',
			params.slice(0, 3)
		);
		const items = result.rows.slice(0, limit).map((r) => {
			const { data, ...row } = r;
			return redactWorkspaceRecord(t.role, 'contacts', { ...data, ...row });
		});
		const last = items.at(-1);
		await serviceAudit(client, t.id, session.userId, 'contacts.search', 'contacts');
		return {
			items,
			total: count.rows[0].count,
			nextCursor:
				result.rows.length > limit && last
					? Buffer.from(JSON.stringify({ name: last.name, id: last.id })).toString('base64url')
					: null
		};
	});
}
export async function duplicateCandidates(session: TenantSession) {
	const w = session.demo ? await demoAuthorization(session) : null;
	if (w) {
		const seen = new Map<string, any[]>();
		for (const c of w.contacts.filter((c) => !c.archived)) {
			const key = String(c.email || '').toLowerCase();
			if (key) {
				const list = seen.get(key) || [];
				list.push(c);
				seen.set(key, list);
			}
		}
		return [...seen.entries()]
			.filter(([, rows]) => rows.length > 1)
			.map(([value, contacts]) => ({ reason: 'normalized_email', value, contacts }));
	}
	return tenantTransaction(session, editors, async (client, t) => {
		const result = await client.query(
			"SELECT m.kind AS reason,m.normalized_value AS value,jsonb_agg(jsonb_build_object('id',c.id,'name',c.name,'email',c.email)) AS contacts FROM contact_methods m JOIN contacts c ON c.tenant_id=m.tenant_id AND c.id=m.contact_id WHERE m.tenant_id=$1 AND c.archived_at IS NULL GROUP BY m.kind,m.normalized_value HAVING count(DISTINCT c.id)>1 UNION ALL SELECT 'name_address',lower(c.name)||'|'||lower(a.line1)||'|'||lower(a.postal_code),jsonb_agg(jsonb_build_object('id',c.id,'name',c.name,'email',c.email)) FROM contacts c JOIN addresses a ON a.tenant_id=c.tenant_id AND a.contact_id=c.id WHERE c.tenant_id=$1 AND c.archived_at IS NULL GROUP BY lower(c.name),lower(a.line1),lower(a.postal_code) HAVING count(DISTINCT c.id)>1",
			[t.id]
		);
		return result.rows;
	});
}
export async function contactDetail(session: TenantSession, contactId: string) {
	if (!uuid.safeParse(contactId).success)
		throw new ServiceError('Contact identifier is invalid.', 422);
	if (session.demo) {
		const w = await demoAuthorization(session, contactReaders);
		const contact = w.contacts.find((c) => c.id === contactId && !c.archived);
		if (!contact) throw new ServiceError('Contact not found.', 404);
		const aliases = (w.contactAliases || []).filter((a) => a.mergedInto === contactId);
		const ids = new Set([contactId, ...aliases.map((a) => a.id)]);
		const gifts = w.gifts.filter((g) => ids.has(String(g.contactId || '')));
		const byCurrency = new Map<
			string,
			{ currency: string; grossMinor: number; giftCount: number }
		>();
		for (const gift of gifts) {
			if (gift.status !== 'recorded' || ['correction', 'pledge'].includes(String(gift.kind)))
				continue;
			const currency = String(gift.currency || 'USD');
			const row = byCurrency.get(currency) || { currency, grossMinor: 0, giftCount: 0 };
			row.grossMinor += Number(gift.amountMinor) || 0;
			row.giftCount++;
			byCurrency.set(currency, row);
		}
		return { contact, aliases, givingByCurrency: [...byCurrency.values()] };
	}
	return tenantTransaction(session, contactReaders, async (client, t) => {
		const found = await client.query(
			'SELECT id,name,email,stage,tags,data,created_at AS "createdAt",updated_at AS "updatedAt" FROM contacts WHERE tenant_id=$1 AND id=$2 AND archived_at IS NULL AND merged_into IS NULL',
			[t.id, contactId]
		);
		if (!found.rowCount) throw new ServiceError('Contact not found.', 404);
		const [aliases, giving] = await Promise.all([
			client.query(
				'WITH RECURSIVE aliases AS (SELECT id,name FROM contacts WHERE tenant_id=$1 AND merged_into=$2 UNION SELECT c.id,c.name FROM contacts c JOIN aliases a ON c.merged_into=a.id WHERE c.tenant_id=$1) SELECT id,name FROM aliases ORDER BY name,id',
				[t.id, contactId]
			),
			client.query(
				`WITH RECURSIVE aliases AS (SELECT id FROM contacts WHERE tenant_id=$1 AND merged_into=$2 UNION SELECT c.id FROM contacts c JOIN aliases a ON c.merged_into=a.id WHERE c.tenant_id=$1), identities AS (SELECT $2::uuid AS id UNION SELECT id FROM aliases) SELECT g.currency,COALESCE(sum(g.amount_minor) FILTER(WHERE g.status='recorded' AND g.kind NOT IN('correction','pledge')),0) AS "grossMinor",count(*) FILTER(WHERE g.status='recorded' AND g.kind NOT IN('correction','pledge'))::int AS "giftCount",max(g.occurred_at) FILTER(WHERE g.status='recorded' AND g.kind NOT IN('correction','pledge')) AS "lastGiftAt" FROM gifts g JOIN identities i ON i.id=g.contact_id WHERE g.tenant_id=$1 GROUP BY g.currency ORDER BY g.currency`,
				[t.id, contactId]
			)
		]);
		const { data, ...columns } = found.rows[0];
		const contact = { ...((data as object) || {}), ...columns };
		await serviceAudit(client, t.id, session.userId, 'contact.detail.read', 'contacts', contactId);
		return {
			contact,
			aliases: aliases.rows,
			givingByCurrency: giving.rows.map((row: any) => ({
				...row,
				grossMinor: safeMinorUnits(row.grossMinor, 'Contact giving')
			}))
		};
	});
}
export function mapContactCsv(csv: string, mapping?: Record<string, string>) {
	if (!mapping) return csv;
	const parsed = Papa.parse<Record<string, string>>(csv, { header: true, skipEmptyLines: true });
	if (parsed.errors.length) throw new ServiceError('CSV cannot be parsed.');
	const allowed = ['name', 'email', 'phone', 'stage', 'tags'];
	const out = parsed.data.map((row) =>
		Object.fromEntries(allowed.map((field) => [field, row[mapping[field] || field] || '']))
	);
	return Papa.unparse(out);
}
export async function importReviewed(
	session: TenantSession,
	csv: string,
	dryRun: boolean,
	mapping?: Record<string, string>
) {
	const normalized = mapContactCsv(csv, mapping);
	const fingerprint = createHash('sha256').update(normalized).digest('hex');
	if (session.demo) {
		const w = await demoAuthorization(session, editors);
		const preview = analyzeContactCsv(
			normalized,
			w.contacts.map((c) => String(c.email || '')),
			w.contacts.map((c) => String(c.phone || ''))
		);
		if (dryRun) return { dryRun: true, preview };
		if (preview.invalidCount || preview.duplicateCount)
			throw new ServiceError('Resolve duplicate and invalid rows before importing.', 409);
		const contacts = preview.rows.map((r) => r.contact!);
		const result = await importContactsDemo(session.tenantSlug, contacts);
		return { imported: result.length, preview };
	}
	return tenantTransaction(session, editors, async (client, t) => {
		const existing = await client.query(
			"SELECT email,data->>'phone' AS phone FROM contacts WHERE tenant_id=$1",
			[t.id]
		);
		const preview = analyzeContactCsv(
			normalized,
			existing.rows.map((c) => c.email || ''),
			existing.rows.map((c) => c.phone || '')
		);
		if (dryRun) return { dryRun: true, preview };
		if (preview.duplicateCount || preview.invalidCount)
			throw new ServiceError(
				'Resolve duplicate and invalid rows before importing; nothing was imported.',
				409
			);
		const existingBatch = await client.query(
			'SELECT id FROM contact_import_batches WHERE tenant_id=$1 AND fingerprint=$2',
			[t.id, fingerprint]
		);
		if (existingBatch.rowCount)
			throw new ServiceError('This exact import batch has already been processed.', 409);
		const ids: string[] = [];
		for (const row of preview.rows) {
			const c = row.contact!,
				id = randomUUID();
			ids.push(id);
			await client.query(
				"INSERT INTO contacts(tenant_id,id,name,email,stage,tags,data) VALUES($1,$2,$3,nullif($4,''),$5,$6,$7)",
				[t.id, id, c.name, c.email, c.stage, c.tags, c]
			);
			await serviceEvent(
				client,
				t.id,
				'contact.created',
				{ contactId: id },
				'contact.imported:' + t.id + ':' + id
			);
		}
		const batch = (
			await client.query(
				'INSERT INTO contact_import_batches(tenant_id,actor_id,fingerprint,contact_ids,snapshot) VALUES($1,$2,$3,$4,$5) RETURNING id',
				[t.id, session.userId, fingerprint, ids, JSON.stringify(preview)]
			)
		).rows[0];
		await serviceAudit(
			client,
			t.id,
			session.userId,
			'contacts.imported',
			'contact_import_batches',
			batch.id,
			{ count: ids.length }
		);
		return { imported: ids.length, batchId: batch.id, preview };
	});
}

export async function directoryMetadata(session: TenantSession) {
	if (session.demo)
		return {
			filters: await demoRead(session, 'crm.filters'),
			importBatches: await demoRead(session, 'crm.importBatches')
		};
	return tenantTransaction(session, null, async (client, t) => {
		const filters = await client.query(
			'SELECT id,name,definition FROM saved_filters WHERE tenant_id=$1 AND user_id=$2',
			[t.id, session.userId]
		);
		const batches = editors.includes(t.role as (typeof editors)[number])
			? await client.query(
					'SELECT id,created_at AS "createdAt",cardinality(contact_ids) AS "importedCount",rolled_back_at AS "rolledBackAt" FROM contact_import_batches WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 50',
					[t.id]
				)
			: { rows: [] };
		return { filters: filters.rows, importBatches: batches.rows };
	});
}

export async function contactTimeline(
	session: TenantSession,
	contactId: string,
	options: { kind?: string; cursor?: string; limit?: number } = {}
) {
	if (!uuid.safeParse(contactId).success)
		throw new ServiceError('Contact identifier is invalid.', 422);
	const limit = Math.min(100, Math.max(1, options.limit || 25));
	const kinds = ['all', 'gift', 'activity', 'task', 'note', 'email', 'automation', 'consent'];
	const kind = options.kind || 'all';
	if (!kinds.includes(kind)) throw new ServiceError('Timeline filter is invalid.', 422);
	let cursor: { at: string; id: string; kind: string } | null = null;
	if (options.cursor) {
		try {
			cursor = z
				.object({ at: z.iso.datetime(), id: uuid, kind: z.string().max(30) })
				.parse(JSON.parse(Buffer.from(options.cursor, 'base64url').toString()));
		} catch {
			throw new ServiceError('Timeline cursor is invalid.', 422);
		}
	}
	if (session.demo) {
		const w = await demoAuthorization(session, contactReaders);
		if (!w.contacts.some((c) => c.id === contactId))
			throw new ServiceError('Contact not found.', 404);
		const rows = [
			...w.activities
				.filter((c) => c.contactId === contactId)
				.map((c) => ({
					...c,
					kind: 'activity',
					at: c.occurredAt || c.createdAt,
					summary: c.summary
				})),
			...w.gifts
				.filter((c) => c.contactId === contactId)
				.map((c) => ({
					...c,
					kind: 'gift',
					at: c.occurredAt || c.createdAt,
					summary: `${c.currency} ${c.amountMinor} minor units · ${c.status}`
				})),
			...w.tasks
				.filter((c) => c.contactId === contactId)
				.map((c) => ({ ...c, kind: 'task', at: c.createdAt || c.dueAt, summary: c.title }))
		]
			.filter((c) => kind === 'all' || c.kind === kind)
			.sort((a, b) => String(b.at).localeCompare(String(a.at)));
		return { items: rows.slice(0, limit), nextCursor: null };
	}
	return tenantTransaction(session, contactReaders, async (client, t) => {
		await assertContact(client, t.id, contactId);
		const result = await client.query(
			`WITH RECURSIVE identities AS (SELECT id FROM contacts WHERE tenant_id=$1 AND id=$2 UNION SELECT c.id FROM contacts c JOIN identities i ON c.merged_into=i.id WHERE c.tenant_id=$1), timeline AS (
  SELECT a.id,a.occurred_at AS at,'activity'::text AS kind,a.summary,jsonb_build_object('activityKind',a.kind) AS details FROM activities a JOIN identities i ON i.id=a.contact_id WHERE a.tenant_id=$1
  UNION ALL SELECT g.id,g.occurred_at,'gift',g.status||' '||g.kind,jsonb_build_object('amountMinor',g.amount_minor,'currency',g.currency,'correctionOf',g.correction_of) FROM gifts g JOIN identities i ON i.id=g.contact_id WHERE g.tenant_id=$1
  UNION ALL SELECT x.id,x.created_at,'task',x.title,jsonb_build_object('status',x.status,'dueAt',x.due_at) FROM tasks x JOIN identities i ON i.id=x.contact_id WHERE x.tenant_id=$1
  UNION ALL SELECT n.id,n.created_at,'note',n.body,jsonb_build_object('restricted',n.sensitive) FROM notes n JOIN identities i ON i.id=n.contact_id WHERE n.tenant_id=$1 AND ($3 OR NOT n.sensitive)
  UNION ALL SELECT e.id,e.created_at,'email',e.subject,jsonb_build_object('status',e.status) FROM email_messages e JOIN identities i ON i.id=e.contact_id WHERE e.tenant_id=$1
  UNION ALL SELECT r.id,r.created_at,'automation',d.name,jsonb_build_object('status',r.state) FROM automation_runs r JOIN identities i ON i.id=r.contact_id JOIN automation_definitions d ON d.tenant_id=r.tenant_id AND d.id=r.automation_id WHERE r.tenant_id=$1
  UNION ALL SELECT c.id,c.recorded_at,'consent',c.channel||' '||c.purpose||': '||c.status,jsonb_build_object('source',c.source) FROM consents c JOIN identities i ON i.id=c.contact_id WHERE c.tenant_id=$1
  ) SELECT id,at,kind,summary,details FROM timeline WHERE ($4='all' OR kind=$4) AND ($5::timestamptz IS NULL OR (at,id,kind)<($5::timestamptz,$6::uuid,$7::text)) ORDER BY at DESC,id DESC,kind DESC LIMIT $8`,
			[
				t.id,
				contactId,
				restricted(t.role),
				kind,
				cursor?.at || null,
				cursor?.id || null,
				cursor?.kind || null,
				limit + 1
			]
		);
		const items = result.rows.slice(0, limit);
		const last = items.at(-1);
		await serviceAudit(
			client,
			t.id,
			session.userId,
			'contact.timeline.read',
			'contacts',
			contactId
		);
		return {
			items,
			nextCursor:
				result.rows.length > limit && last
					? Buffer.from(
							JSON.stringify({ at: new Date(last.at).toISOString(), id: last.id, kind: last.kind })
						).toString('base64url')
					: null
		};
	});
}
