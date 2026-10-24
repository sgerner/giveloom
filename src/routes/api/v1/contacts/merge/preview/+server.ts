import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { env } from '$env/dynamic/private';
import { previewPostgresContactMerge } from '$lib/server/database';
import { previewDemoContactMerge } from '$lib/server/store';
import { readLimitedBody } from '$lib/server/request';

const schema = z
	.object({
		tenant: z.string().min(1).max(80),
		sourceContactId: z.string().uuid(),
		targetContactId: z.string().uuid()
	})
	.strict();
export async function POST({ request, locals }) {
	if (!locals.session) return json({ error: 'Sign in before merging contacts.' }, { status: 401 });
	try {
		const input = schema.parse(JSON.parse(await readLimitedBody(request, 4_000)));
		if (input.tenant !== locals.session.tenantSlug)
			return json(
				{ error: 'The requested tenant is not in your active session.' },
				{ status: 403 }
			);
		const preview = env.DATABASE_URL
			? await previewPostgresContactMerge(
					input.tenant,
					locals.session.userId,
					input.sourceContactId,
					input.targetContactId
				)
			: locals.session.demo
				? await previewDemoContactMerge(
						input.tenant,
						input.sourceContactId,
						input.targetContactId,
						locals.session.role
					)
				: null;
		if (!preview)
			return json({ error: 'Contact merge requires a persistent workspace.' }, { status: 503 });
		return json(preview, { headers: { 'cache-control': 'private, no-store' } });
	} catch (error) {
		return json(
			{ error: error instanceof Error ? error.message : 'Merge preview failed.' },
			{ status: (error as { status?: number }).status || (error instanceof RangeError ? 413 : 400) }
		);
	}
}
