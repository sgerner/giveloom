import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { CommunicationError, listEmailDrafts, saveEmailTemplate } from '$lib/server/communications';
const schema = z
	.object({
		name: z.string().min(1).max(180),
		subject: z.string().min(1).max(998),
		htmlBody: z.string().max(100000).default(''),
		textBody: z.string().max(95000).optional(),
		variables: z.array(z.string().max(80)).max(40).optional()
	})
	.strict();
export async function GET({ locals }) {
	if (!locals.session) return json({ error: 'Sign in required.' }, { status: 401 });
	try {
		const drafts = await listEmailDrafts(locals.session);
		return json({ templates: 'templates' in drafts ? drafts.templates : [] });
	} catch (error) {
		return json(
			{ error: error instanceof CommunicationError ? error.message : 'Templates unavailable.' },
			{ status: error instanceof CommunicationError ? error.status : 503 }
		);
	}
}
export async function POST({ request, locals }) {
	if (!locals.session) return json({ error: 'Sign in required.' }, { status: 401 });
	try {
		return json(await saveEmailTemplate(locals.session, schema.parse(await request.json())), {
			status: 201
		});
	} catch (error) {
		return json(
			{
				error: error instanceof CommunicationError ? error.message : 'Template could not be saved.'
			},
			{ status: error instanceof CommunicationError ? error.status : 400 }
		);
	}
}
