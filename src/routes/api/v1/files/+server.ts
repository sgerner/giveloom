import { json } from '@sveltejs/kit';
import {
	FileApiError,
	listTenantFiles,
	safeOriginalName,
	storeTenantFile
} from '$lib/server/files';

const maxUploadBytes = 26 * 1024 * 1024;
const maxFileBytes = 25 * 1024 * 1024;

async function readRequestBody(request: Request) {
	const length = Number(request.headers.get('content-length') ?? 0);
	if (length > maxUploadBytes) throw new FileApiError('Upload request is too large.', 413);
	if (!request.body) throw new FileApiError('A multipart upload is required.', 400);
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > maxUploadBytes) {
				await reader.cancel().catch(() => undefined);
				throw new FileApiError('Upload request is too large.', 413);
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

function errorResponse(error: unknown) {
	if (error instanceof FileApiError)
		return json({ error: error.message }, { status: error.status });
	if (error instanceof RangeError)
		return json({ error: 'File must be no larger than 25 MiB.' }, { status: 413 });
	if (error instanceof TypeError) return json({ error: error.message }, { status: 415 });
	return json({ error: 'File service is temporarily unavailable.' }, { status: 503 });
}

export async function GET({ locals, url }) {
	const session = locals.session;
	if (!session) return json({ error: 'Sign in before viewing files.' }, { status: 401 });
	if (session.demo)
		return json({ error: 'Private file storage is unavailable in demo mode.' }, { status: 503 });
	const limitValue = Number(url.searchParams.get('limit') ?? '50');
	if (!Number.isInteger(limitValue) || limitValue < 1 || limitValue > 100)
		return json({ error: 'limit must be an integer from 1 to 100.' }, { status: 400 });
	try {
		const result = await listTenantFiles(session, {
			contactId: url.searchParams.get('contactId') ?? undefined,
			limit: limitValue
		});
		return json(result, { headers: { 'cache-control': 'private, no-store' } });
	} catch (error) {
		return errorResponse(error);
	}
}

export async function POST({ request, locals }) {
	const session = locals.session;
	if (!session) return json({ error: 'Sign in before uploading files.' }, { status: 401 });
	if (session.demo)
		return json({ error: 'Private file storage is unavailable in demo mode.' }, { status: 503 });
	const contentType = request.headers.get('content-type') ?? '';
	if (!contentType.toLowerCase().startsWith('multipart/form-data;'))
		return json({ error: 'Upload must use multipart/form-data.' }, { status: 415 });
	try {
		const bytes = await readRequestBody(request);
		const multipart = await new Request(request.url, {
			method: 'POST',
			headers: { 'content-type': contentType },
			body: bytes
		}).formData();
		if (Array.from(multipart.keys()).some((key) => !['file', 'contactId'].includes(key)))
			throw new FileApiError('Only file and contactId fields are accepted.', 400);
		const file = multipart.get('file');
		if (!(file instanceof File)) throw new FileApiError('A single file field is required.', 400);
		if (multipart.getAll('file').length !== 1)
			throw new FileApiError('Upload one file at a time.', 400);
		if (multipart.getAll('contactId').length > 1)
			throw new FileApiError('Provide at most one contactId.', 400);
		if (file.size < 1 || file.size > maxFileBytes)
			throw new FileApiError('File must be between 1 byte and 25 MiB.', 413);
		const contactId = multipart.get('contactId');
		if (
			contactId !== null &&
			(typeof contactId !== 'string' ||
				!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
					contactId
				))
		)
			throw new FileApiError('contactId must be a UUID.', 400);
		const created = await storeTenantFile(session, {
			bytes: new Uint8Array(await file.arrayBuffer()),
			mediaType: file.type.toLowerCase(),
			originalName: safeOriginalName(file.name),
			...(typeof contactId === 'string' ? { contactId } : {})
		});
		return json(
			{ ok: true, file: created },
			{ status: 201, headers: { 'cache-control': 'private, no-store' } }
		);
	} catch (error) {
		return errorResponse(error);
	}
}
