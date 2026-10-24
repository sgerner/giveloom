import { json } from '@sveltejs/kit';
import { reportingInsights } from '$lib/server/reporting';
import { serviceResponseError } from '$lib/server/tenant-service';
export async function GET({ url, locals }) {
	try {
		if (!locals.session) return json({ error: 'Sign in first.' }, { status: 401 });
		return json(
			await reportingInsights(
				locals.session,
				Object.fromEntries([...url.searchParams].filter(([, v]) => v))
			),
			{ headers: { 'cache-control': 'private, no-store' } }
		);
	} catch (e) {
		const problem = serviceResponseError(e);
		return json({ error: problem.error }, { status: problem.status });
	}
}
