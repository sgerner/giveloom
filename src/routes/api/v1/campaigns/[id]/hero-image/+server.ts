import { json } from '@sveltejs/kit';
import { getCampaign, saveCampaignDraft } from '$lib/server/campaigns';
import { FileApiError, safeOriginalName, storeTenantFile } from '$lib/server/files';

function detectImage(bytes: Uint8Array) {
	if (
		bytes.length >= 8 &&
		bytes[0] === 0x89 &&
		bytes[1] === 0x50 &&
		bytes[2] === 0x4e &&
		bytes[3] === 0x47 &&
		bytes[4] === 0x0d &&
		bytes[5] === 0x0a &&
		bytes[6] === 0x1a &&
		bytes[7] === 0x0a
	)
		return 'image/png';
	if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
		return 'image/jpeg';
	if (
		bytes.length >= 12 &&
		String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' &&
		String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP'
	)
		return 'image/webp';
	return null;
}

export async function POST({ params, request, locals }) {
	if (!locals.session)
		return json({ error: 'Sign in before uploading a campaign image.' }, { status: 401 });
	if (locals.session.demo)
		return json({ error: 'Campaign images require persistent storage.' }, { status: 503 });
	try {
		const form = await request.formData();
		if (Array.from(form.keys()).some((key) => key !== 'file'))
			throw new FileApiError('Only one image file is accepted.', 400);
		const file = form.get('file');
		if (!(file instanceof File) || form.getAll('file').length !== 1)
			throw new FileApiError('Upload one campaign image.', 400);
		if (file.size < 1 || file.size > 5_242_880)
			throw new FileApiError('Campaign image must be no larger than 5 MiB.', 413);
		const bytes = new Uint8Array(await file.arrayBuffer());
		const mediaType = detectImage(bytes);
		if (!mediaType)
			throw new FileApiError(
				'Use a valid PNG, JPEG, or WebP image. SVG and animated images are not accepted.',
				415
			);
		const current = await getCampaign(locals.session, params.id);
		const uploaded = await storeTenantFile(locals.session, {
			bytes,
			mediaType,
			originalName: safeOriginalName(file.name)
		});
		const saved = await saveCampaignDraft(locals.session, params.id, {
			expectedVersion: current.version,
			draft: { ...current.draft, heroImageFileId: uploaded.id }
		});
		return json(
			{ file: uploaded, version: saved.version, heroImageFileId: uploaded.id },
			{ status: 201, headers: { 'cache-control': 'private, no-store' } }
		);
	} catch (error) {
		const status =
			Number((error as { status?: number })?.status) ||
			((error as { name?: string }).name === 'ZodError' ? 422 : 400);
		return json(
			{ error: error instanceof Error ? error.message : 'Campaign image could not be saved.' },
			{ status, headers: { 'cache-control': 'private, no-store' } }
		);
	}
}
