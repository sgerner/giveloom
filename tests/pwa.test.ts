import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { transform } from 'esbuild';
import { runInNewContext } from 'node:vm';

const asset = (path: string) => readFile(new URL(`../static/${path}`, import.meta.url));

describe('PWA assets and privacy boundaries', () => {
	it('provides installable icons with the required dimensions', async () => {
		const manifest = JSON.parse((await asset('manifest.webmanifest')).toString('utf8'));
		expect(manifest.display).toBe('standalone');
		expect(
			manifest.icons.map((icon: { sizes: string; purpose?: string }) => [icon.sizes, icon.purpose])
		).toEqual([
			['192x192', 'any'],
			['512x512', 'any'],
			['512x512', 'maskable']
		]);
		for (const [path, size] of [
			['icons/icon-192.png', 192],
			['icons/icon-512.png', 512],
			['icons/icon-maskable-512.png', 512]
		] as const) {
			const png = await asset(path);
			expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
			expect(png.readUInt32BE(16)).toBe(size);
			expect(png.readUInt32BE(20)).toBe(size);
		}
	});

	async function harness() {
		const source = (
			await readFile(new URL('../src/service-worker.ts', import.meta.url), 'utf8')
		).replace(
			"import { build, version } from '$service-worker';",
			"const build=['/_app/immutable/app.js'];const version='test';"
		);
		const { code } = await transform(source, { loader: 'ts', format: 'cjs' });
		const listeners: Record<string, (event: any) => void> = {};
		const cache = {
			match: vi.fn(async () => new Response('Offline: no private data available')),
			put: vi.fn(),
			addAll: vi.fn(async (_urls: string[]) => {})
		};
		const fetcher = vi.fn(async () => new Response('Private donor data'));
		const self = {
			location: { origin: 'https://crm.test' },
			addEventListener: (name: string, fn: (event: any) => void) => {
				listeners[name] = fn;
			},
			skipWaiting: vi.fn(),
			clients: { claim: vi.fn() }
		};
		runInNewContext(code, {
			self,
			URL,
			Response,
			fetch: fetcher,
			caches: {
				open: async () => cache,
				match: async () => undefined,
				keys: async () => [],
				delete: vi.fn()
			}
		});
		return { listeners, cache, fetcher, self };
	}
	it('never handles API data or non-GET mutations with a shared cache', async () => {
		const { listeners, cache } = await harness();
		for (const [url, method] of [
			['/api/v1/workspace', 'GET'],
			['/api/files/private', 'GET'],
			['/api/v1/donation-intents', 'POST']
		]) {
			const respondWith = vi.fn();
			listeners.fetch({
				request: { url: 'https://crm.test' + url, method, mode: 'cors' },
				respondWith
			});
			expect(respondWith).not.toHaveBeenCalled();
		}
		expect(cache.put).not.toHaveBeenCalled();
	});
	it('fetches private documents from network and returns only a generic fallback offline', async () => {
		const { listeners, cache, fetcher } = await harness();
		let response: Promise<Response> | undefined;
		const event = {
			request: { url: 'https://crm.test/app/tenant/contacts', method: 'GET', mode: 'navigate' },
			respondWith: (value: Promise<Response>) => {
				response = value;
			}
		};
		listeners.fetch(event);
		expect(await (await response!).text()).toBe('Private donor data');
		expect(cache.put).not.toHaveBeenCalled();
		fetcher.mockRejectedValueOnce(new Error('offline'));
		listeners.fetch(event);
		expect(await (await response!).text()).toContain('no private data');
		expect(cache.put).not.toHaveBeenCalled();
	});
	it('precaches only public assets and waits for an explicit update request', async () => {
		const { listeners, cache, self } = await harness();
		let pending: Promise<unknown> | undefined;
		listeners.install({
			waitUntil: (promise: Promise<unknown>) => {
				pending = promise;
			}
		});
		await pending;
		const urls = cache.addAll.mock.calls[0][0] as string[];
		expect(
			urls.every(
				(url) => !url.startsWith('/app/') && !url.startsWith('/api/') && !url.startsWith('/donate/')
			)
		).toBe(true);
		expect(self.skipWaiting).not.toHaveBeenCalled();
		listeners.message({ data: { type: 'SKIP_WAITING' } });
		expect(self.skipWaiting).toHaveBeenCalledOnce();
	});
});
