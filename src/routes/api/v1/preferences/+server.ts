import { themes } from '$lib/themes';
import { json } from '@sveltejs/kit';
import { z } from 'zod';
import {
	tenantTransaction,
	demoAuthorization,
	serviceAudit,
	serviceResponseError
} from '$lib/server/tenant-service';
import { demoRead, demoWrite } from '$lib/server/demo-extensions';
import { readLimitedBody } from '$lib/server/request';
const schema = z
	.object({
		theme: z
			.string()
			.refine(
				(v) => v === 'donor-crm' || themes.some((theme) => theme === v),
				'Unknown installed theme.'
			)
			.optional(),
		mode: z.enum(['light', 'dark', 'system']).optional(),
		greeting: z.string().trim().max(120).optional(),
		reportWidgets: z
			.array(
				z.enum(['summary', 'monthly', 'campaign', 'source', 'cohorts', 'pipeline', 'dictionary'])
			)
			.max(7)
			.optional()
	})
	.strict();
export async function GET({ locals }) {
	try {
		if (!locals.session) return json({ error: 'Sign in first.' }, { status: 401 });
		const s = locals.session;
		const preferences = s.demo
			? (await demoRead(s, 'preferences')).find((p) => p.id === s.userId) || {}
			: await tenantTransaction(
					s,
					null,
					async (c, t) =>
						(
							await c.query('SELECT data FROM user_settings WHERE tenant_id=$1 AND user_id=$2', [
								t.id,
								s.userId
							])
						).rows[0]?.data || {}
				);
		return json({ preferences }, { headers: { 'cache-control': 'private, no-store' } });
	} catch (e) {
		const p = serviceResponseError(e);
		return json({ error: p.error }, { status: p.status });
	}
}
export async function PATCH({ request, locals }) {
	try {
		if (!locals.session) return json({ error: 'Sign in first.' }, { status: 401 });
		const s = locals.session,
			value = schema.parse(JSON.parse(await readLimitedBody(request, 10000)));
		if (s.demo) {
			await demoAuthorization(s);
			await demoWrite(s, null, (records) => {
				records.preferences ||= [];
				let row = records.preferences.find((r) => r.id === s.userId);
				if (!row) {
					row = { id: s.userId };
					records.preferences.push(row);
				}
				Object.assign(row, value);
			});
		} else
			await tenantTransaction(s, null, async (c, t) => {
				await c.query(
					'INSERT INTO user_settings(tenant_id,user_id,data) VALUES($1,$2,$3) ON CONFLICT(tenant_id,user_id) DO UPDATE SET data=user_settings.data||EXCLUDED.data',
					[t.id, s.userId, value]
				);
				await serviceAudit(c, t.id, s.userId, 'preferences.update', 'user_settings', undefined, {
					keys: Object.keys(value)
				});
			});
		return json({ ok: true, preferences: value });
	} catch (e) {
		const p = serviceResponseError(e);
		return json({ error: p.error }, { status: p.status });
	}
}
