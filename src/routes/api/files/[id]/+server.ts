import { json } from '@sveltejs/kit';
import { Readable } from 'node:stream';
import { FileApiError, downloadTenantFile } from '$lib/server/files';

function downloadName(name: string) {
	const fallback =
		name
			.replace(/[^\x20-\x7e]/g, '_')
			.replace(/["\\;]/g, '_')
			.slice(0, 150) || 'attachment';
	return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

export async function GET({ locals, params }) {
	const session = locals.session;
	if (!session) return json({ error: 'Sign in before downloading files.' }, { status: 401 });
	if (session.demo)
		return json({ error: 'Private file storage is unavailable in demo mode.' }, { status: 503 });
	try {
		const { file, stream } = await downloadTenantFile(session, params.id);
		return new Response(Readable.toWeb(stream) as ReadableStream, {
			headers: {
				'content-type': file.mediaType,
				'content-length': String(file.sizeBytes),
				'content-disposition': downloadName(file.name),
				'cache-control': 'private, no-store',
				'x-content-type-options': 'nosniff',
				'content-security-policy': "sandbox; default-src 'none'; frame-ancestors 'none'"
			}
		});
	} catch (error) {
		const status = error instanceof FileApiError ? error.status : 503;
		return json(
			{
				error:
					error instanceof FileApiError ? error.message : 'File service is temporarily unavailable.'
			},
			{ status, headers: { 'cache-control': 'no-store' } }
		);
	}
}
