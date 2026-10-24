import { json } from '@sveltejs/kit';
import { z } from 'zod';
import {
	AssistantError,
	getAssistantSettings,
	setAssistantUserLimit,
	updateAssistantSettings
} from '$lib/server/ai-assistant';
import { readLimitedBody } from '$lib/server/request';

export async function GET({ locals }) {
	if (!locals.session)
		return json({ error: 'Sign in before viewing AI settings.' }, { status: 401 });
	try {
		return json(await getAssistantSettings(locals.session), {
			headers: { 'cache-control': 'private, no-store' }
		});
	} catch (error) {
		return json(
			{ error: error instanceof AssistantError ? error.message : 'AI settings are unavailable.' },
			{ status: error instanceof AssistantError ? error.status : 503 }
		);
	}
}

export async function PUT({ request, locals }) {
	if (!locals.session)
		return json({ error: 'Sign in before changing AI settings.' }, { status: 401 });
	if (
		process.env.NODE_ENV === 'production' &&
		new URL(request.url).protocol !== 'https:' &&
		request.headers.get('x-forwarded-proto') !== 'https'
	)
		return json({ error: 'AI settings may only be changed over HTTPS.' }, { status: 400 });
	try {
		const body = JSON.parse(await readLimitedBody(request, 8_192));
		return json(await updateAssistantSettings(locals.session, body), {
			headers: { 'cache-control': 'private, no-store' }
		});
	} catch (error) {
		if (error instanceof z.ZodError)
			return json({ error: 'AI settings did not match the required fields.' }, { status: 422 });
		return json(
			{
				error:
					error instanceof AssistantError
						? error.message
						: error instanceof SyntaxError
							? 'A JSON request is required.'
							: 'AI settings could not be saved.'
			},
			{
				status:
					error instanceof AssistantError ? error.status : error instanceof SyntaxError ? 400 : 503
			}
		);
	}
}

export async function PATCH({ request, locals }) {
	if (!locals.session)
		return json({ error: 'Sign in before changing AI user budgets.' }, { status: 401 });
	try {
		const body = z
			.object({
				userId: z.string().uuid(),
				requestsPerDay: z.number().int(),
				tokensPerDay: z.number().int(),
				costMicroUsdPerDay: z.number().int()
			})
			.strict()
			.parse(JSON.parse(await readLimitedBody(request, 4_096)));
		const { userId, ...limits } = body;
		return json(await setAssistantUserLimit(locals.session, userId, limits), {
			headers: { 'cache-control': 'private, no-store' }
		});
	} catch (error) {
		if (error instanceof z.ZodError)
			return json({ error: 'User budget did not match the required fields.' }, { status: 422 });
		return json(
			{
				error:
					error instanceof AssistantError
						? error.message
						: error instanceof SyntaxError
							? 'A JSON request is required.'
							: 'User budget could not be saved.'
			},
			{
				status:
					error instanceof AssistantError ? error.status : error instanceof SyntaxError ? 400 : 503
			}
		);
	}
}
