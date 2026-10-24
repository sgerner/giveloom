import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { env } from '$env/dynamic/private';
import { undoPostgresContactMerge } from '$lib/server/database';
import { undoDemoContactMerge } from '$lib/server/store';
import { readLimitedBody } from '$lib/server/request';

const schema = z.object({ tenant: z.string().min(1).max(80), mergeId: z.string().uuid() }).strict();
export async function POST({ request, locals }) {
	if (!locals.session) return json({ error: 'Sign in before undoing a merge.' }, { status: 401 });
	try {
		const input = schema.parse(JSON.parse(await readLimitedBody(request, 4_000)));
		if (input.tenant !== locals.session.tenantSlug)
			return json(
				{ error: 'The requested tenant is not in your active session.' },
				{ status: 403 }
			);
		const result = env.DATABASE_URL
			? await undoPostgresContactMerge(input.tenant, locals.session.userId, input.mergeId)
			: locals.session.demo
				? await undoDemoContactMerge(input.tenant, input.mergeId, locals.session.role)
				: null;
		if (!result)
			return json(
				{ error: 'Contact merge undo requires a persistent workspace.' },
				{ status: 503 }
			);
		return json({ ok: true, ...result }, { headers: { 'cache-control': 'private, no-store' } });
	} catch (error) {
		return json(
			{ error: error instanceof Error ? error.message : 'Contact merge undo failed.' },
			{ status: (error as { status?: number }).status || (error instanceof RangeError ? 413 : 400) }
		);
	}
}
