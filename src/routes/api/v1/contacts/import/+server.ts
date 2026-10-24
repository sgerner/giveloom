import { readLimitedBody } from '$lib/server/request';
import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { importReviewed } from '$lib/server/crm';
import { analyzeContactCsv } from '$lib/server/csv';
import { importContactsDemo, getWorkspace, recordDemoRead } from '$lib/server/store';
import { findExistingContactEmailsPostgres, importContactsPostgres } from '$lib/server/database';
import { env } from '$env/dynamic/private';

const requestSchema = z
	.object({
		tenant: z.string().min(1).max(80),
		csv: z.string(),
		dryRun: z.boolean().default(true),
		mapping: z.record(z.string(), z.string()).optional()
	})
	.strict();
function errorResponse(error: unknown) {
	const err = error as { status?: number; name?: string; issues?: unknown };
	const code = String((error as { code?: unknown })?.code || '');
	if (code === '23505')
		return json(
			{ error: 'A record with the same unique value already exists; no rows were imported.' },
			{ status: 409 }
		);
	if (code === '23503')
		return json(
			{
				error: 'A referenced record is missing or belongs to another tenant; no rows were imported.'
			},
			{ status: 422 }
		);
	if (code === '42501')
		return json({ error: 'Your role cannot import contacts.' }, { status: 403 });
	if (/^08/.test(code) || /^57/.test(code))
		return json(
			{ error: 'The database is temporarily unavailable; no rows were imported.' },
			{ status: 503 }
		);
	if (code)
		return json(
			{ error: 'The import could not be completed; no rows were imported.' },
			{ status: 500 }
		);
	return json(
		{
			error: error instanceof Error ? error.message : 'Import could not be completed.',
			...(err.name === 'ZodError' ? { details: err.issues } : {})
		},
		{ status: err.status || (err.name === 'ZodError' ? 422 : 400) }
	);
}

export async function POST({ request, locals }) {
	try {
		const session = locals.session;
		if (!session) return json({ error: 'Sign in before importing contacts.' }, { status: 401 });
		const length = Number(request.headers.get('content-length') || 0);
		if (length > 1_100_000)
			return json(
				{ error: 'CSV upload is too large. Maximum request size is 1 MB.' },
				{ status: 413 }
			);
		const body = requestSchema.parse(JSON.parse(await readLimitedBody(request, 1_100_000)));
		if (body.tenant !== session.tenantSlug)
			return json(
				{ error: 'The requested tenant is not in your active session.' },
				{ status: 403 }
			);
		if (body.csv.length > 1_000_000)
			return json({ error: 'CSV upload is too large. Maximum size is 1 MB.' }, { status: 413 });
		const result = await importReviewed(session, body.csv, body.dryRun, body.mapping);
		return json(result, {
			status: body.dryRun ? 200 : 201,
			headers: { 'cache-control': 'private, no-store' }
		});
	} catch (error) {
		return errorResponse(error);
	}
}
