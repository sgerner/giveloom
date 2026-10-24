import { json } from '@sveltejs/kit';
import { getAutomation, pauseAutomation, updateAutomationDraft } from '$lib/server/automation';
const demoUnavailable = () =>
	json(
		{ error: 'Workflow management requires persistent storage and is unavailable in demo mode.' },
		{ status: 503, headers: { 'cache-control': 'private, no-store' } }
	);
const fail = (error: unknown) =>
	json(
		{ error: error instanceof Error ? error.message : 'Workflow request failed.' },
		{
			status:
				Number((error as { status?: number })?.status) ||
				((error as { name?: string })?.name === 'ZodError' ? 422 : 400)
		}
	);
export async function GET({ params, locals }) {
	if (locals.session?.demo) return demoUnavailable();
	try {
		return json(await getAutomation(locals.session, params.id), {
			headers: { 'cache-control': 'private, no-store' }
		});
	} catch (error) {
		return fail(error);
	}
}
export async function PATCH({ params, request, locals }) {
	if (locals.session?.demo) return demoUnavailable();
	try {
		return json(await updateAutomationDraft(locals.session, params.id, await request.json()));
	} catch (error) {
		return fail(error);
	}
}
export async function DELETE({ params, locals }) {
	if (locals.session?.demo) return demoUnavailable();
	try {
		return json(await pauseAutomation(locals.session, params.id));
	} catch (error) {
		return fail(error);
	}
}
