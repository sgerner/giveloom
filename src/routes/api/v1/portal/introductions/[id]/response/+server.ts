import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { env } from '$env/dynamic/private';
import { PortalError, respondToPortalIntroduction } from '$lib/server/portal';
import { readLimitedBody } from '$lib/server/request';

const schema = z
	.object({ answer: z.enum(['yes', 'no', 'unsure']), note: z.string().max(1000).default('') })
	.strict();
export async function POST({ request, cookies, params }) {
	try {
		if (!env.DATABASE_URL) return json({ error: 'Donor portal is unavailable.' }, { status: 503 });
		const input = schema.parse(JSON.parse(await readLimitedBody(request, 4096)));
		const result = await respondToPortalIntroduction(cookies.get('giveloom_portal'), {
			introductionId: params.id,
			...input
		});
		return json({ ok: true, ...result }, { headers: { 'cache-control': 'private, no-store' } });
	} catch (error) {
		const status =
			error instanceof PortalError ? error.status : error instanceof z.ZodError ? 400 : 503;
		return json(
			{
				error:
					error instanceof PortalError || error instanceof Error
						? error.message
						: 'Response could not be saved.'
			},
			{ status }
		);
	}
}
