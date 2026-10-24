import { getCalendarIcs } from '$lib/server/stewardship';
export async function GET({ url, locals }) {
	try {
		const body = await getCalendarIcs(
			locals.session,
			url.searchParams.get('from') || undefined,
			url.searchParams.get('to') || undefined
		);
		return new Response(body, {
			headers: {
				'content-type': 'text/calendar; charset=utf-8',
				'content-disposition': 'attachment; filename="giveloom-stewardship.ics"',
				'cache-control': 'private, no-store'
			}
		});
	} catch (error) {
		return new Response(
			JSON.stringify({ error: error instanceof Error ? error.message : 'Calendar unavailable.' }),
			{
				status: Number((error as { status?: number })?.status) || 400,
				headers: { 'content-type': 'application/json' }
			}
		);
	}
}
