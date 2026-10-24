import { json } from '@sveltejs/kit';
import { z } from 'zod';
import {
	CommunicationError,
	deleteEmailTemplate,
	saveEmailTemplate
} from '$lib/server/communications';
const schema = z
	.object({
		name: z.string().min(1).max(180),
		subject: z.string().min(1).max(998),
		htmlBody: z.string().max(100000).default(''),
		textBody: z.string().max(95000).optional(),
		variables: z.array(z.string().max(80)).max(40).optional()
	})
	.strict();
export async function PATCH({ request, locals, params }) {
	if (!locals.session) return json({ error: 'Sign in required.' }, { status: 401 });
	try {
		return json(
			await saveEmailTemplate(locals.session, {
				id: params.id,
				...schema.parse(await request.json())
			})
		);
	} catch (error) {
		return json(
			{
				error: error instanceof CommunicationError ? error.message : 'Template could not be saved.'
			},
			{ status: error instanceof CommunicationError ? error.status : 400 }
		);
	}
}
export async function DELETE({ locals, params }) {
	if (!locals.session) return json({ error: 'Sign in required.' }, { status: 401 });
	try {
		return json(await deleteEmailTemplate(locals.session, params.id));
	} catch (error) {
		return json(
			{
				error:
					error instanceof CommunicationError ? error.message : 'Template could not be removed.'
			},
			{ status: error instanceof CommunicationError ? error.status : 503 }
		);
	}
}
