import { json } from '@sveltejs/kit';
import { givingStatement, renderGivingStatementHtml } from '$lib/server/giving';
import { serviceResponseError } from '$lib/server/tenant-service';

export async function GET({ url, locals }) {
	try {
		if (!locals.session) return json({ error: 'Sign in first.' }, { status: 401 });
		const statement = await givingStatement(
			locals.session,
			url.searchParams.get('contactId'),
			url.searchParams.get('year')
		);
		const headers = {
			'cache-control': 'private, no-store',
			'content-security-policy':
				"default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
			'X-Content-Type-Options': 'nosniff'
		};
		if (url.searchParams.get('format') === 'html') {
			return new Response(renderGivingStatementHtml(statement), {
				headers: { ...headers, 'content-type': 'text/html; charset=utf-8' }
			});
		}
		return json(statement, { headers });
	} catch (error) {
		const result = serviceResponseError(error);
		return json(
			{ error: result.error },
			{ status: result.status, headers: { 'cache-control': 'private, no-store' } }
		);
	}
}
