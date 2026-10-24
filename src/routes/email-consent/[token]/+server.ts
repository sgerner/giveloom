import { confirmEmailConsent } from '$lib/server/communications';
const html = (title: string, body: string) =>
	new Response(
		`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><main style="font:16px system-ui;max-width:38rem;margin:4rem auto;padding:1rem"><h1>${title}</h1>${body}</main></html>`,
		{
			headers: {
				'content-type': 'text/html; charset=utf-8',
				'cache-control': 'no-store',
				'x-content-type-options': 'nosniff',
				'content-security-policy':
					"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
			}
		}
	);
export async function GET({ params }) {
	return html(
		'Confirm email updates',
		`<p>Confirm that you want to receive email updates from this organization. This will add your address to marketing email only; it will not authorize unrelated messages.</p><form method="post"><button type="submit">Confirm email updates</button></form>`
	);
}
export async function POST({ params }) {
	try {
		const result = await confirmEmailConsent(params.token);
		return result.confirmed
			? html('Email updates confirmed', '<p>Your email preferences have been confirmed.</p>')
			: html(
					'Link unavailable',
					'<p>This confirmation link is invalid, expired, or already used.</p>'
				);
	} catch {
		return html(
			'Confirmation unavailable',
			'<p>Email preferences could not be updated right now. Please try again later.</p>'
		);
	}
}
