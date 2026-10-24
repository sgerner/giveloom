import { json } from '@sveltejs/kit';
import { listGiftReceipts, ReceiptError } from '$lib/server/receipts';

export async function GET({ locals, url }) {
	if (!locals.session)
		return json(
			{ error: 'Sign in to view receipts.' },
			{ status: 401, headers: { 'cache-control': 'no-store' } }
		);
	try {
		const result = await listGiftReceipts(
			locals.session,
			url.searchParams.get('contactId') ?? undefined
		);
		return json(result, { headers: { 'cache-control': 'private, no-store' } });
	} catch (error) {
		return json(
			{
				error:
					error instanceof ReceiptError
						? error.message
						: 'Receipt service is temporarily unavailable.'
			},
			{
				status: error instanceof ReceiptError ? error.status : 503,
				headers: { 'cache-control': 'no-store' }
			}
		);
	}
}
