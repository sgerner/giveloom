import { platformCommand } from '$lib/server/platform';
import { readLimitedBody } from '$lib/server/request';
import { serviceResponseError } from '$lib/server/tenant-service';
import { json } from '@sveltejs/kit';
import { adminResponseError, listPlatformTenants } from '$lib/server/admin';
export async function GET({ locals }) {
	try {
		return json(
			{ tenants: await listPlatformTenants(locals.session) },
			{ headers: { 'cache-control': 'private, no-store' } }
		);
	} catch (error) {
		const result = adminResponseError(error);
		return json(
			{ error: result.error },
			{ status: result.status, headers: { 'cache-control': 'no-store' } }
		);
	}
}

export async function POST({ request, locals }) {
	try {
		return json(
			{
				ok: true,
				result: await platformCommand(
					locals.session,
					JSON.parse(await readLimitedBody(request, 20000))
				)
			},
			{ headers: { 'cache-control': 'private, no-store' } }
		);
	} catch (e) {
		const p = serviceResponseError(e);
		return json({ error: p.error }, { status: p.status });
	}
}
