import { error } from '@sveltejs/kit';
import { getGiftReceiptHtml, ReceiptError } from '$lib/server/receipts';

export async function GET({ locals, params }) {
	if (!locals.session) throw error(401, 'Sign in to view receipts.');
	try {
		const receipt = await getGiftReceiptHtml(locals.session, params.id);
		return new Response(receipt.html, {
			headers: {
				'content-type': 'text/html; charset=utf-8',
				'content-disposition': `attachment; filename="${receipt.receiptNumber}.html"`,
				'cache-control': 'private, no-store',
				'x-content-type-options': 'nosniff',
				'content-security-policy':
					"default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
			}
		});
	} catch (cause) {
		if (cause instanceof ReceiptError) throw error(cause.status, cause.message);
		throw error(503, 'Receipt service is temporarily unavailable.');
	}
}
