import {
	tenantTransaction,
	demoAuthorization,
	serviceAudit,
	ServiceError,
	type TenantSession
} from './tenant-service';
import { formatMoney } from '$lib/money';
export async function searchWorkspace(session: TenantSession, query: string) {
	const q = query.trim();
	if (q.length > 100) throw new ServiceError('Search is limited to 100 characters.', 422);
	if (q.length < 2) return { items: [] };
	const base = '/app/' + encodeURIComponent(session.tenantSlug);
	if (session.demo) {
		const w = await demoAuthorization(session);
		return {
			items: [
				...w.contacts.map((c) => ({
					id: c.id,
					name: c.name,
					kind: 'Person',
					url: base + '/contacts/' + c.id
				})),
				...w.campaigns.map((c) => ({
					id: c.id,
					name: c.name,
					kind: 'Campaign',
					url: base + '/campaigns/' + c.id
				})),
				...w.prospects.map((c) => ({
					id: c.id,
					name: c.name,
					kind: 'Prospect',
					url: base + '/prospects/' + c.id
				})),
				...w.gifts.map((g) => ({
					id: g.id,
					name: formatMoney(Number(g.amountMinor), String(g.currency)),
					kind: 'Gift',
					url: base + '/gifts'
				}))
			]
				.filter((r) => String(r.name).toLowerCase().includes(q.toLowerCase()) || r.id === q)
				.slice(0, 40)
		};
	}
	return tenantTransaction(session, null, async (c, t) => {
		const pattern = '%' + q.replace(/[%_\\]/g, '\\$&') + '%';
		const hasPII = [
			'owner',
			'admin',
			'fundraising_manager',
			'fundraiser',
			'finance',
			'finance_manager',
			'analyst',
			'marketer'
		].includes(t.role);
		const finances = [
			'owner',
			'admin',
			'finance',
			'finance_manager',
			'fundraising_manager',
			'fundraiser',
			'analyst'
		].includes(t.role);
		const [contacts, campaigns, prospects, gifts] = await Promise.all([
			c.query(
				'SELECT id,name FROM contacts WHERE tenant_id=$1 AND archived_at IS NULL AND merged_into IS NULL AND (name ILIKE $2 OR ($3 AND email ILIKE $2)) ORDER BY name,id LIMIT 10',
				[t.id, pattern, hasPII]
			),
			c.query(
				"SELECT id,name FROM campaigns WHERE tenant_id=$1 AND status<>'archived' AND name ILIKE $2 ORDER BY name,id LIMIT 10",
				[t.id, pattern]
			),
			hasPII
				? c.query(
						"SELECT id,name FROM prospects WHERE tenant_id=$1 AND stage<>'archived' AND name ILIKE $2 ORDER BY name,id LIMIT 10",
						[t.id, pattern]
					)
				: { rows: [] },
			finances
				? c.query(
						'SELECT id,amount_minor,currency,status FROM gifts WHERE tenant_id=$1 AND (id::text ILIKE $2 OR amount_minor::text=$3) ORDER BY occurred_at DESC LIMIT 10',
						[t.id, pattern, q]
					)
				: { rows: [] }
		]);
		const items = [
			...contacts.rows.map((r) => ({ ...r, kind: 'Person', url: base + '/contacts/' + r.id })),
			...campaigns.rows.map((r) => ({ ...r, kind: 'Campaign', url: base + '/campaigns/' + r.id })),
			...prospects.rows.map((r) => ({ ...r, kind: 'Prospect', url: base + '/prospects/' + r.id })),
			...gifts.rows.map((r) => ({
				id: r.id,
				name: formatMoney(Number(r.amount_minor), String(r.currency).trim()) + ' · ' + r.status,
				kind: 'Gift',
				url: base + '/gifts'
			}))
		];
		await serviceAudit(c, t.id, session.userId, 'workspace.search', 'search', undefined, {
			queryLength: q.length,
			count: items.length
		});
		return { items };
	});
}
