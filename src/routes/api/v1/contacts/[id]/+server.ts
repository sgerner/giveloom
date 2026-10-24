import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { env } from '$env/dynamic/private';
import { contactDetail } from '$lib/server/crm';
import { applyMutation } from '$lib/server/store';
import { mutatePostgres } from '$lib/server/database';
import { validateResource } from '$lib/server/domain';
import { ApiTokenError, apiTokenResponseError, resolveApiSession } from '$lib/server/api-tokens';
import { serviceResponseError } from '$lib/server/tenant-service';

const patchSchema = z
	.object({
		name: z.string().trim().min(1).max(180).optional(),
		email: z.string().trim().email().or(z.literal('')).optional(),
		phone: z.string().trim().max(80).optional(),
		stage: z.string().trim().max(80).optional(),
		tags: z.array(z.string().trim().min(1).max(80)).max(100).optional()
	})
	.strict()
	.refine(
		(value) => Object.keys(value).length > 0,
		'Provide at least one contact field to update.'
	);

export async function GET({ params, request, locals }) {
	try {
		const session = await resolveApiSession(request, locals.session, 'contacts:read');
		return json(await contactDetail(session, params.id), {
			headers: { 'cache-control': 'private, no-store' }
		});
	} catch (error) {
		const result =
			error instanceof ApiTokenError ? apiTokenResponseError(error) : serviceResponseError(error);
		return json({ error: result.error }, { status: result.status });
	}
}

export async function PATCH({ params, request, locals }) {
	const session = locals.session;
	if (!session) return json({ error: 'Sign in to update this contact.' }, { status: 401 });
	try {
		const patch = patchSchema.parse(await request.json());
		const { contact } = await contactDetail(session, params.id);
		const data = validateResource('contacts', { ...contact, ...patch, id: params.id }) as Record<
			string,
			unknown
		>;
		let item: Record<string, unknown>;
		if (env.DATABASE_URL)
			item = await mutatePostgres(session.tenantSlug, session.userId, 'contacts', data, 'update');
		else {
			if (!session.demo)
				return json({ error: 'A persistent workspace is required.' }, { status: 503 });
			item = (await applyMutation(session.tenantSlug, 'contacts', data, 'update', session.role))
				.item;
		}
		return json({ contact: item }, { headers: { 'cache-control': 'private, no-store' } });
	} catch (error) {
		if (error instanceof z.ZodError)
			return json(
				{ error: 'Contact update validation failed.', details: error.issues },
				{ status: 422 }
			);
		const result = serviceResponseError(error);
		return json({ error: result.error }, { status: result.status });
	}
}
