import { json } from '@sveltejs/kit';
import { redactWorkspaceRecord } from '$lib/server/domain';
import {
	demoAuthorization,
	serviceAudit,
	serviceResponseError,
	tenantTransaction
} from '$lib/server/tenant-service';
import { recordDemoRead } from '$lib/server/store';
import { segmentMatches } from '$lib/server/communications';
import {
	householdGivingSummaries,
	summarizeDemoHouseholdGiving
} from '$lib/server/household-giving';

const resources = ['organizations', 'households', 'segments'] as const;
type Collection = (typeof resources)[number];
const readers: Record<Collection, string[]> = {
	organizations: ['owner', 'admin', 'fundraising_manager', 'fundraiser', 'marketer'],
	households: ['owner', 'admin', 'fundraising_manager', 'fundraiser'],
	segments: ['owner', 'admin', 'fundraising_manager', 'fundraiser', 'marketer']
};
function decodeCursor(value: string | null) {
	if (!value) return null;
	try {
		const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
		if (
			typeof parsed.name !== 'string' ||
			typeof parsed.id !== 'string' ||
			!/^[0-9a-f-]{36}$/i.test(parsed.id)
		)
			return null;
		return parsed as { name: string; id: string };
	} catch {
		return null;
	}
}
function encodeCursor(name: string, id: string) {
	return Buffer.from(JSON.stringify({ name, id })).toString('base64url');
}
function safeUrl(value: unknown) {
	if (typeof value !== 'string' || !value) return '';
	try {
		const url = new URL(value);
		return ['http:', 'https:'].includes(url.protocol) ? url.toString() : '';
	} catch {
		return '';
	}
}

export async function GET({ params, url, locals }) {
	try {
		const resource = params.resource as Collection;
		if (!resources.includes(resource))
			return json({ error: 'Unknown collection.' }, { status: 404 });
		const session = locals.session;
		const query = (url.searchParams.get('q') || '').trim().slice(0, 120);
		const sort = url.searchParams.get('sort') === 'name_desc' ? 'name_desc' : 'name_asc';
		const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 25));
		const cursorValue = url.searchParams.get('cursor');
		const cursor = decodeCursor(cursorValue);
		if (cursorValue && !cursor)
			return json({ error: 'Invalid collection cursor.' }, { status: 400 });
		if (session?.demo) {
			const workspace = await demoAuthorization(session, readers[resource]);
			await recordDemoRead(session.tenantSlug, `collection.${resource}.read`);
			const source = workspace[resource] as Record<string, any>[];
			const matches = source.filter(
				(item) =>
					!item.archived &&
					(!query ||
						`${item.name || ''} ${item.id || ''}`.toLowerCase().includes(query.toLowerCase()))
			);
			matches.sort((a, b) => {
				const byName = String(a.name || '').localeCompare(String(b.name || ''), undefined, {
					sensitivity: 'base'
				});
				const byId = String(a.id).localeCompare(String(b.id));
				const result = byName || byId;
				return sort === 'name_asc' ? result : -result;
			});
			const cursorIndex = cursor
				? matches.findIndex(
						(item) => String(item.id) === cursor.id && String(item.name || '') === cursor.name
					)
				: -1;
			if (cursor && cursorIndex < 0)
				return json({ error: 'Collection cursor is no longer available.' }, { status: 400 });
			const start = cursor ? cursorIndex + 1 : 0;
			const page = matches.slice(Math.max(0, start), Math.max(0, start) + limit + 1);
			const more = page.length > limit;
			const resultPage = page.slice(0, limit);
			const demoHouseholds = resultPage.map((item) => ({
				id: String(item.id),
				memberIds: Array.isArray(item.memberIds)
					? item.memberIds.filter((id): id is string => typeof id === 'string')
					: []
			}));
			const demoGiving =
				resource === 'households'
					? summarizeDemoHouseholdGiving(
							demoHouseholds,
							workspace.contactAliases || [],
							workspace.gifts
						)
					: new Map();
			const resultItems = resultPage.map((item) => {
				const result = { ...item };
				if (resource === 'organizations') result.website = safeUrl(result.website);
				if (resource === 'households') {
					const byId = new Map(
						workspace.contacts.map((contact: any) => [contact.id, contact.name])
					);
					result.memberNames = (Array.isArray(result.memberIds) ? result.memberIds : [])
						.map((id: string) => byId.get(id))
						.filter(Boolean);
				}
				if (resource === 'segments')
					result.matchingContactCount = workspace.contacts.filter(
						(contact: any) => !contact.archived && segmentMatches(contact, result.rules)
					).length;
				if (resource === 'households')
					result.hardCreditGivingByCurrency = demoGiving.get(String(result.id)) || [];
				return redactWorkspaceRecord(session.role, resource, result);
			});
			const last = page[Math.min(limit, page.length) - 1];
			return json(
				{
					items: resultItems,
					total: matches.length,
					nextCursor: more && last ? encodeCursor(String(last.name || ''), String(last.id)) : null,
					sort,
					canWrite: readers[resource].includes(session.role),
					...(resource === 'households'
						? { givingSummaryPolicy: 'Hard-credit gifts only; soft credits are excluded.' }
						: {})
				},
				{ headers: { 'cache-control': 'private, no-store' } }
			);
		}
		const result = await tenantTransaction(session, readers[resource], async (client, tenant) => {
			const values: unknown[] = [tenant.id, resource];
			let where = 'tenant_id=$1 AND resource=$2 AND archived_at IS NULL';
			if (query) {
				values.push(`%${query}%`);
				where += ` AND data->>'name' ILIKE $${values.length}`;
			}
			const count = await client.query(
				`SELECT count(*)::int AS total FROM workspace_records WHERE ${where}`,
				values
			);
			const pageValues = [...values];
			if (cursor) {
				pageValues.push(cursor.name, cursor.id);
				where +=
					sort === 'name_asc'
						? ` AND (lower(data->>'name'),id) > (lower($${pageValues.length - 1}),$${pageValues.length}::uuid)`
						: ` AND (lower(data->>'name'),id) < (lower($${pageValues.length - 1}),$${pageValues.length}::uuid)`;
			}
			pageValues.push(limit + 1);
			const order = sort === 'name_asc' ? 'ASC' : 'DESC';
			const rows = await client.query(
				`SELECT id,data,created_at AS "createdAt",updated_at AS "updatedAt" FROM workspace_records WHERE ${where} ORDER BY lower(data->>'name') ${order},id ${order} LIMIT $${pageValues.length}`,
				pageValues
			);
			const more = rows.rows.length > limit;
			const page = rows.rows.slice(0, limit);
			const memberIds = [
				...new Set(
					page.flatMap((row) =>
						resource === 'households' && Array.isArray(row.data.memberIds)
							? row.data.memberIds.filter((id: unknown): id is string => typeof id === 'string')
							: []
					)
				)
			];
			const members = memberIds.length
				? await client.query(
						'SELECT id,name FROM contacts WHERE tenant_id=$1 AND id=ANY($2::uuid[]) AND archived_at IS NULL AND merged_into IS NULL',
						[tenant.id, memberIds]
					)
				: { rows: [] };
			const memberNames = new Map(members.rows.map((row) => [row.id, row.name]));
			const items = page.map((row) => {
				const item = {
					...row.data,
					id: row.id,
					createdAt: row.createdAt,
					updatedAt: row.updatedAt
				};
				if (resource === 'organizations') item.website = safeUrl(item.website);
				if (resource === 'households')
					item.memberNames = (Array.isArray(item.memberIds) ? item.memberIds : [])
						.map((id: string) => memberNames.get(id))
						.filter(Boolean);
				return redactWorkspaceRecord(tenant.role, resource, item);
			});
			if (resource === 'households') {
				const summaries = await householdGivingSummaries(
					client,
					tenant.id,
					page.map((row) => row.id)
				);
				for (const item of items)
					item.hardCreditGivingByCurrency = summaries.get(String(item.id)) || [];
			}
			let matchingContactCount: number | undefined;
			if (resource === 'segments') {
				const active = await client.query(
					"SELECT id,data FROM workspace_records WHERE tenant_id=$1 AND resource='segments' AND id=ANY($2::uuid[])",
					[tenant.id, page.map((row) => row.id)]
				);
				const rulesById = new Map(active.rows.map((row) => [row.id, row.data.rules]));
				const counts = new Map(page.map((row) => [row.id, 0]));
				let last = '';
				while (true) {
					const contacts = await client.query(
						`SELECT id,name,email,data,stage,tags,created_at AS "createdAt" FROM contacts WHERE tenant_id=$1 AND archived_at IS NULL AND merged_into IS NULL AND id::text>$2 ORDER BY id LIMIT 1000`,
						[tenant.id, last]
					);
					if (!contacts.rowCount) break;
					for (const contact of contacts.rows) {
						last = contact.id;
						for (const row of page)
							if (segmentMatches(contact, rulesById.get(row.id)))
								counts.set(row.id, (counts.get(row.id) || 0) + 1);
					}
					if (contacts.rowCount < 1000) break;
				}
				for (const item of items) item.matchingContactCount = counts.get(item.id) || 0;
				matchingContactCount = page.reduce((sum, item) => sum + (counts.get(item.id) || 0), 0);
			}
			await serviceAudit(
				client,
				tenant.id,
				session!.userId,
				'collection.directory.read',
				resource,
				undefined,
				{ query: Boolean(query), sort, returned: items.length }
			);
			return {
				items,
				total: count.rows[0].total,
				nextCursor:
					more && page.length
						? encodeCursor(String(page.at(-1).data.name || ''), page.at(-1).id)
						: null,
				sort,
				canWrite: readers[resource].includes(tenant.role),
				...(resource === 'households'
					? { givingSummaryPolicy: 'Hard-credit gifts only; soft credits are excluded.' }
					: {}),
				...(matchingContactCount === undefined ? {} : { matchingContactCount })
			};
		});
		return json(result, { headers: { 'cache-control': 'private, no-store' } });
	} catch (e) {
		const error = serviceResponseError(e);
		return json({ error: error.error }, { status: error.status });
	}
}
