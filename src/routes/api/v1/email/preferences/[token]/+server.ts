import { json } from '@sveltejs/kit';
import { z } from 'zod';
import {
	getEmailPreferences,
	requestEmailConsent,
	updateEmailPreferences
} from '$lib/server/communications';
export async function GET({ params }) {
	try {
		const preferences = await getEmailPreferences(params.token);
		return preferences
			? json(
					{ marketingEnabled: preferences.marketingEnabled },
					{ headers: { 'cache-control': 'no-store' } }
				)
			: json({ error: 'Preference link is invalid or expired.' }, { status: 404 });
	} catch {
		return json({ error: 'Preference service is temporarily unavailable.' }, { status: 503 });
	}
}
export async function POST({ params, request, getClientAddress }) {
	try {
		const { enabled } = z
			.object({ enabled: z.boolean() })
			.strict()
			.parse(await request.json());
		const result = await updateEmailPreferences(params.token, enabled);
		if (!result) return json({ error: 'Preference link is invalid or expired.' }, { status: 404 });
		if (enabled)
			await requestEmailConsent(
				result.tenantSlug,
				result.email,
				result.contactId,
				getClientAddress()
			);
		return json(
			{ updated: true, confirmationRequired: enabled },
			{ headers: { 'cache-control': 'no-store' } }
		);
	} catch (error) {
		return json(
			{
				error:
					error instanceof z.ZodError
						? 'Preference update is invalid.'
						: 'Preference service is temporarily unavailable.'
			},
			{ status: error instanceof z.ZodError ? 400 : 503 }
		);
	}
}
