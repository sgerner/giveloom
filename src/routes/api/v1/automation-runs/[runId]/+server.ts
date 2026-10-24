import { json } from '@sveltejs/kit';
import {
	getAutomationRunSteps,
	cancelAutomationRun,
	retryAutomationRun
} from '$lib/server/automation';
export async function GET({ params, locals }) {
	try {
		return json(await getAutomationRunSteps(locals.session, params.runId), {
			headers: { 'cache-control': 'private, no-store' }
		});
	} catch (error) {
		return json(
			{ error: error instanceof Error ? error.message : 'Run unavailable.' },
			{ status: Number((error as { status?: number })?.status) || 400 }
		);
	}
}
export async function PATCH({ params, request, locals }) {
	try {
		const { action } = await request.json();
		return json(
			action === 'retry'
				? await retryAutomationRun(locals.session, params.runId)
				: action === 'cancel'
					? await cancelAutomationRun(locals.session, params.runId)
					: { error: 'action must be retry or cancel.' },
			{ status: action === 'retry' || action === 'cancel' ? 200 : 422 }
		);
	} catch (error) {
		return json(
			{ error: error instanceof Error ? error.message : 'Run update failed.' },
			{ status: Number((error as { status?: number })?.status) || 400 }
		);
	}
}
