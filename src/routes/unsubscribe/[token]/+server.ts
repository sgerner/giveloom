import { CommunicationError, recordUnsubscribe } from '$lib/server/communications';

const page = (message: string, success = false) =>
	new Response(
		`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Email preferences</title><body style="font:16px system-ui;max-width:38rem;margin:12vh auto;padding:0 1.25rem;color:#27342f"><main><h1>${success ? 'You are unsubscribed' : 'Email preferences'}</h1><p>${message}</p>${success ? '' : '<form method="post"><button type="submit">Unsubscribe from marketing email</button></form>'}</main></body></html>`,
		{
			status: success ? 200 : 200,
			headers: {
				'content-type': 'text/html; charset=utf-8',
				'cache-control': 'no-store',
				'content-security-policy':
					"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
				'x-content-type-options': 'nosniff'
			}
		}
	);

export function GET() {
	return page(
		'Confirm below to stop future marketing email from this organization. This link does not change your account or donation records.'
	);
}

export async function POST({ params }) {
	try {
		await recordUnsubscribe(params.token);
		return page('Your address has been added to this organization’s suppression list.', true);
	} catch (error) {
		const status = error instanceof CommunicationError ? error.status : 503;
		return new Response(
			'This unsubscribe request could not be completed. Please try again or contact the organization.',
			{
				status,
				headers: {
					'content-type': 'text/plain; charset=utf-8',
					'cache-control': 'no-store',
					'x-content-type-options': 'nosniff'
				}
			}
		);
	}
}
