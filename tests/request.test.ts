import { describe, expect, it } from 'vitest';
import { readLimitedBody } from '../src/lib/server/request';

describe('bounded request body reader', () => {
	it('accepts a valid chunked request within its limit', async () => {
		const body = await readLimitedBody(
			new Request('https://example.test/api', { method: 'POST', body: '{"ok":true}' }),
			20
		);
		expect(JSON.parse(body)).toEqual({ ok: true });
	});

	it('rejects declared and chunked oversized input', async () => {
		await expect(
			readLimitedBody(new Request('https://example.test/api', { method: 'POST', body: '12345' }), 4)
		).rejects.toThrow(/too large/i);
		const chunked = new Request('https://example.test/api', {
			method: 'POST',
			duplex: 'half',
			body: new ReadableStream({
				start(controller) {
					controller.enqueue(new TextEncoder().encode('123'));
					controller.enqueue(new TextEncoder().encode('456'));
					controller.close();
				}
			})
		} as RequestInit);
		await expect(readLimitedBody(chunked, 4)).rejects.toThrow(/too large/i);
	});
});
