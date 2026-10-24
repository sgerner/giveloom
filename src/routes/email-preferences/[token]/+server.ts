import { getEmailPreferences, updateEmailPreferences } from '$lib/server/communications';
const html = (body: string) =>
	new Response(
		`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Email preferences</title><main style="font:16px system-ui;max-width:38rem;margin:4rem auto;padding:1rem"><h1>Email preferences</h1>${body}</main></html>`,
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
	try {
		const state = await getEmailPreferences(params.token);
		if (!state) return html('<p>This preference link is invalid or expired.</p>');
		return html(
			`<p>Marketing updates are currently ${state.marketingEnabled ? 'on' : 'off'}.</p><form method="post"><input type="hidden" name="enabled" value="false"><button type="submit">Unsubscribe from marketing email</button></form><p>To subscribe again, contact the organization and confirm a new double opt-in message.</p>`
		);
	} catch {
		return html('<p>Preferences are temporarily unavailable.</p>');
	}
}
export async function POST({ params }) {
	try {
		const result = await updateEmailPreferences(params.token, false);
		return result
			? html('<p>Your marketing email preference is now off.</p>')
			: html('<p>This preference link is invalid or expired.</p>');
	} catch {
		return html('<p>Preferences are temporarily unavailable.</p>');
	}
}
