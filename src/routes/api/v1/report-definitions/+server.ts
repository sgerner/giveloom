import { json } from '@sveltejs/kit';
import { z } from 'zod';
import {
	createReportDefinition,
	listReportDefinitions,
	pauseReportSchedule,
	ReportScheduleError,
	reportScheduleErrorStatus,
	scheduleReport,
	updateReportDefinition
} from '$lib/server/report-schedules';

const id = z.string().uuid();
const definition = z
	.object({
		name: z.string().trim().min(1).max(160),
		reportKey: z.enum(['giving', 'retention']),
		filters: z.record(z.string(), z.unknown()).optional()
	})
	.strict();
const schedule = z
	.object({
		definitionId: id,
		frequency: z.enum(['daily', 'weekly', 'monthly']),
		localTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
		weekday: z.number().int().min(0).max(6).optional(),
		timezone: z.string().min(1).max(80),
		approved: z.literal(true)
	})
	.strict();

export async function GET({ locals }) {
	if (!locals.session) return json({ error: 'Sign in to access saved reports.' }, { status: 401 });
	try {
		return json(await listReportDefinitions(locals.session), {
			headers: { 'cache-control': 'private, no-store' }
		});
	} catch (error) {
		return json(
			{
				error:
					error instanceof ReportScheduleError ? error.message : 'Saved reports are unavailable.'
			},
			{ status: reportScheduleErrorStatus(error), headers: { 'cache-control': 'no-store' } }
		);
	}
}
export async function POST({ request, locals }) {
	if (!locals.session)
		return json({ error: 'Sign in to save or schedule reports.' }, { status: 401 });
	try {
		const body = await request.json();
		if (body?.action === 'schedule')
			return json(
				await scheduleReport(locals.session, schedule.parse(body), undefined, new Date()),
				{ status: 201, headers: { 'cache-control': 'private, no-store' } }
			);
		return json(await createReportDefinition(locals.session, definition.parse(body)), {
			status: 201,
			headers: { 'cache-control': 'private, no-store' }
		});
	} catch (error) {
		if (error instanceof z.ZodError)
			return json({ error: 'Report definition or schedule is invalid.' }, { status: 422 });
		return json(
			{
				error: error instanceof ReportScheduleError ? error.message : 'Report could not be saved.'
			},
			{ status: reportScheduleErrorStatus(error), headers: { 'cache-control': 'no-store' } }
		);
	}
}
export async function PUT({ request, locals }) {
	if (!locals.session) return json({ error: 'Sign in to update saved reports.' }, { status: 401 });
	try {
		const body = z
			.object({ id, definition })
			.strict()
			.parse(await request.json());
		return json(await updateReportDefinition(locals.session, body.id, body.definition), {
			headers: { 'cache-control': 'private, no-store' }
		});
	} catch (error) {
		if (error instanceof z.ZodError)
			return json({ error: 'Report definition is invalid.' }, { status: 422 });
		return json(
			{
				error: error instanceof ReportScheduleError ? error.message : 'Report could not be updated.'
			},
			{ status: reportScheduleErrorStatus(error), headers: { 'cache-control': 'no-store' } }
		);
	}
}
export async function DELETE({ url, locals }) {
	if (!locals.session) return json({ error: 'Sign in to pause report delivery.' }, { status: 401 });
	try {
		const scheduleId = id.parse(url.searchParams.get('scheduleId'));
		return json(await pauseReportSchedule(locals.session, scheduleId), {
			headers: { 'cache-control': 'private, no-store' }
		});
	} catch (error) {
		if (error instanceof z.ZodError)
			return json({ error: 'Schedule id is invalid.' }, { status: 422 });
		return json(
			{
				error:
					error instanceof ReportScheduleError ? error.message : 'Schedule could not be paused.'
			},
			{ status: reportScheduleErrorStatus(error), headers: { 'cache-control': 'no-store' } }
		);
	}
}
