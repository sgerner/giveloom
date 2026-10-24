import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { approveEmailSend, CommunicationError } from '$lib/server/communications';

const schema = z
	.object({ previewToken: z.string().min(32).max(128), approved: z.literal(true) })
	.strict();
export async function POST({ request, locals }) {
	if (!locals.session) return json({ error: 'Sign in before approving a send.' }, { status: 401 });
	let input;
	try {
		input = schema.parse(await request.json());
	} catch {
		return json(
			{ error: 'An explicit approval and valid previewToken are required.' },
			{ status: 400 }
		);
	}
	try {
		return json(await approveEmailSend(locals.session, input), {
			status: 202,
			headers: { 'cache-control': 'private, no-store' }
		});
	} catch (error) {
		const status = error instanceof CommunicationError ? error.status : 503;
		return json(
			{ error: error instanceof CommunicationError ? error.message : 'Email could not be queued.' },
			{ status, headers: { 'cache-control': 'no-store' } }
		);
	}
}
