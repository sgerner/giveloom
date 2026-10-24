import { json } from '@sveltejs/kit';
import { FileApiError } from '$lib/server/files';
import { storeTenantBrandLogo } from '$lib/server/branding';

const maxBytes = 3 * 1024 * 1024 + 64 * 1024;
async function bodyBytes(request: Request) {
	const length = Number(request.headers.get('content-length') ?? 0);
	if (length > maxBytes) throw new FileApiError('Logo upload exceeds 3 MiB.', 413);
	if (!request.body) throw new FileApiError('Choose a logo image to upload.', 400);
	const reader = request.body.getReader(),
		chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > maxBytes) {
				await reader.cancel().catch(() => undefined);
				throw new FileApiError('Logo upload exceeds 3 MiB.', 413);
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	return Buffer.concat(
		chunks.map((chunk) => Buffer.from(chunk)),
		total
	);
}
export async function POST({ locals, request }) {
	if (!locals.session)
		return json({ error: 'Sign in before uploading a workspace logo.' }, { status: 401 });
	if (locals.session.demo)
		return json({ error: 'Workspace logos require persistent storage.' }, { status: 503 });
	if (!request.headers.get('content-type')?.toLowerCase().startsWith('multipart/form-data;'))
		return json(
			{ error: 'Upload a PNG, JPEG, or WebP image as multipart form data.' },
			{ status: 415 }
		);
	try {
		const form = await new Request(request.url, {
			method: 'POST',
			headers: { 'content-type': request.headers.get('content-type')! },
			body: await bodyBytes(request)
		}).formData();
		if (Array.from(form.keys()).some((key) => key !== 'file') || form.getAll('file').length !== 1)
			throw new FileApiError('Upload exactly one logo image.', 400);
		const file = form.get('file');
		if (!(file instanceof File)) throw new FileApiError('Choose a PNG, JPEG, or WebP logo.', 400);
		const mediaType = file.type.toLowerCase();
		if (!['image/png', 'image/jpeg', 'image/webp'].includes(mediaType))
			throw new FileApiError('Logo must be a PNG, JPEG, or WebP image.', 415);
		const result = await storeTenantBrandLogo(locals.session, {
			bytes: new Uint8Array(await file.arrayBuffer()),
			mediaType
		});
		return json(
			{ logo: result },
			{ status: 201, headers: { 'cache-control': 'private, no-store' } }
		);
	} catch (error) {
		const status =
			error instanceof FileApiError
				? error.status
				: error instanceof TypeError
					? 415
					: (error as { status?: number })?.status || 503;
		return json(
			{
				error:
					error instanceof Error && status < 500
						? error.message
						: 'Logo could not be stored safely.'
			},
			{ status, headers: { 'cache-control': 'no-store' } }
		);
	}
}
