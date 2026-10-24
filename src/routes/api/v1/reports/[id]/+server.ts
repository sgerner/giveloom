import { segmentMatches } from '$lib/server/communications';
import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { authorizedWorkspace } from '$lib/server/context';
import { canonicalContactId } from '$lib/identity';
import { ledgerReport, donorRetention, type GiftRow } from '$lib/reporting';
import { csvCell } from '$lib/server/csv';
import { recordDemoRead } from '$lib/server/store';
import { auditPostgresRead } from '$lib/server/database';
export async function GET({ params, url, locals }) {
	try {
		if (!['giving', 'retention'].includes(params.id))
			return json({ error: 'Unknown report' }, { status: 404 });
		const workspace = await authorizedWorkspace(
			locals.session,
			url.searchParams.get('tenant') || undefined
		);
		const filters = {
			from: url.searchParams.get('from') || undefined,
			to: url.searchParams.get('to') || undefined,
			campaignId: url.searchParams.get('campaignId') || undefined,
			currency: url.searchParams.get('currency') || workspace.tenant.currency
		};
		const fundId = url.searchParams.get('fundId'),
			ownerId = url.searchParams.get('ownerId'),
			segmentId = url.searchParams.get('segmentId');
		const segment = segmentId ? workspace.segments.find((s) => s.id === segmentId) : null;
		if (segmentId && !segment) return json({ error: 'Segment not found.' }, { status: 404 });
		const allowedContacts = new Set(
			workspace.contacts
				.filter(
					(c) =>
						(!ownerId || c.ownerId === ownerId) &&
						(!segment || segmentMatches({ ...c, data: c }, segment.rules))
				)
				.map((c) => c.id)
		);
		const canonicalGifts = workspace.gifts
			.filter(
				(g) =>
					(!fundId || g.fundId === fundId) &&
					((!ownerId && !segmentId) ||
						allowedContacts.has(
							canonicalContactId(String(g.contactId), workspace.contactAliases || [])
						))
			)
			.map((g) => ({
				...g,
				contactId: g.contactId
					? canonicalContactId(
							String(g.contactId),
							workspace.contactAliases as { id: string; mergedInto: string }[]
						)
					: undefined
			})) as GiftRow[];
		const report =
			params.id === 'retention'
				? donorRetention(
						canonicalGifts,
						Number(url.searchParams.get('year')) || new Date().getUTCFullYear()
					)
				: ledgerReport(canonicalGifts, filters);
		if (url.searchParams.get('format') === 'csv') {
			if (
				!['owner', 'admin', 'finance', 'finance_manager', 'fundraising_manager'].includes(
					workspace.user.role
				)
			)
				return json({ error: 'Your role cannot export finance reports.' }, { status: 403 });
			if (params.id !== 'giving')
				return json({ error: 'Only giving ledger export is available.' }, { status: 400 });
			const giving = report as ReturnType<typeof ledgerReport>;
			if (env.DATABASE_URL)
				await auditPostgresRead(
					locals.session!.tenantSlug,
					locals.session!.userId,
					'report.export',
					'reports'
				);
			else await recordDemoRead(locals.session!.tenantSlug, 'report.export');
			const columns = [
				'id',
				'occurredAt',
				'amountMinor',
				'currency',
				'kind',
				'status',
				'correctionOf',
				'campaignId'
			];
			const csv =
				[
					columns.map(csvCell).join(','),
					...giving.rows.map((row) => columns.map((key) => csvCell(row[key])).join(','))
				].join('\r\n') + '\r\n';
			return new Response(csv, {
				headers: {
					'content-type': 'text/csv;charset=utf-8',
					'content-disposition': 'attachment; filename="giving-ledger.csv"',
					'cache-control': 'private, no-store'
				}
			});
		}
		return json(report, { headers: { 'cache-control': 'private, no-store' } });
	} catch (error) {
		return json(
			{ error: error instanceof Error ? error.message : 'Report unavailable' },
			{ status: Number((error as any)?.status) || 422 }
		);
	}
}
