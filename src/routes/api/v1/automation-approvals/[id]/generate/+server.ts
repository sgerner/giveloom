import { json } from '@sveltejs/kit';
import { AssistantError } from '$lib/server/ai-assistant';
import { AutomationError, generateAutomationApprovalDraft } from '$lib/server/automation';

export async function POST({ params, locals }) {
	try {
		return json(await generateAutomationApprovalDraft(locals.session, params.id), {
			headers: { 'cache-control': 'private, no-store' }
		});
	} catch (error) {
		const status =
			error instanceof AutomationError || error instanceof AssistantError ? error.status : 503;
		return json(
			{
				error:
					error instanceof Error
						? error.message
						: 'AI draft generation failed. No message was sent.'
			},
			{ status, headers: { 'cache-control': 'no-store' } }
		);
	}
}
