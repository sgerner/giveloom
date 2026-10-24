import { json } from '@sveltejs/kit';
import { listAutomationApprovals } from '$lib/server/automation';

const fail = (error: unknown) =>
	json(
		{ error: error instanceof Error ? error.message : 'Workflow approvals unavailable.' },
		{ status: Number((error as { status?: number })?.status) || 400 }
	);
export async function GET({ locals }) {
	try {
		return json(await listAutomationApprovals(locals.session), {
			headers: { 'cache-control': 'private, no-store' }
		});
	} catch (error) {
		return fail(error);
	}
}
