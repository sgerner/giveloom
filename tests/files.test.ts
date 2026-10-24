import { describe, expect, it } from 'vitest';
import { GET as listFiles, POST as uploadFile } from '../src/routes/api/v1/files/+server';
import { GET as downloadFile } from '../src/routes/api/files/[id]/+server';
import {
	FileApiError,
	parseClamAvResponse,
	safeOriginalName,
	scanFile
} from '../src/lib/server/files';

const demoSession = { userId: 'demo-owner', tenantSlug: 'riverstone', role: 'owner', demo: true };

describe('private file contracts', () => {
	it('fails closed in production without malware scanning and allows explicit local development mode', async () => {
		await expect(
			scanFile(new Uint8Array([1]), { host: '', production: true })
		).rejects.toMatchObject({ status: 503 });
		await expect(scanFile(new Uint8Array([1]), { host: '', production: false })).resolves.toBe(
			'not_scanned'
		);
	});

	it('parses only clean scanner responses and treats detections as infected', () => {
		expect(parseClamAvResponse('stream: OK\0')).toBe('clean');
		expect(parseClamAvResponse('stream: Eicar-Test-Signature FOUND\0')).toBe('infected');
		expect(() => parseClamAvResponse('unrecognized')).toThrow(FileApiError);
	});

	it('strips path components and header control characters from original filenames', () => {
		expect(safeOriginalName('../../private\\donor\r\n.pdf')).toBe('donor.pdf');
	});

	it('keeps file APIs unavailable to demo sessions without pretending to persist files', async () => {
		const response = await listFiles({
			locals: { session: demoSession },
			url: new URL('http://localhost/api/v1/files')
		} as never);
		expect(response.status).toBe(503);
		const download = await downloadFile({
			locals: { session: demoSession },
			params: { id: '00000000-0000-4000-8000-000000000000' }
		} as never);
		expect(download.status).toBe(503);
		const upload = await uploadFile({
			locals: { session: demoSession },
			request: new Request('http://localhost/api/v1/files', { method: 'POST' })
		} as never);
		expect(upload.status).toBe(503);
	});
});
