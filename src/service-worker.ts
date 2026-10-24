/// <reference lib="webworker" />
import { build, version } from '$service-worker';

declare const self: ServiceWorkerGlobalScope;

const CACHE = `donor-crm-${version}`;
const STATIC_CACHE = `${CACHE}-static`;
const OFFLINE_URL = '/offline.html';
const PRECACHE = [
	OFFLINE_URL,
	'/favicon.svg',
	'/manifest.webmanifest',
	'/brand/generous-dots.svg',
	'/brand/generous-dots-mono.svg',
	'/brand/wordmark.svg',
	'/brand/wordmark-monochrome.svg',
	'/brand/social-preview.png',
	'/favicon-mono.svg',
	'/icons/icon-192.png',
	'/icons/icon-512.png',
	'/icons/icon-maskable-512.png'
];

// SvelteKit's generated chunks are content-addressed. Static public files are
// cached only when they are in the explicit brand/app-asset allowlist above.
const IMMUTABLE = new Set([
	...PRECACHE,
	...build.filter((path) => path.startsWith('/_app/immutable/'))
]);
const isImmutable = (url: URL) =>
	url.origin === self.location.origin && IMMUTABLE.has(url.pathname);

self.addEventListener('install', (event) => {
	event.waitUntil(
		(async () => {
			const cache = await caches.open(STATIC_CACHE);
			await cache.addAll(PRECACHE);
		})()
	);
});

self.addEventListener('activate', (event) => {
	event.waitUntil(
		(async () => {
			const keys = await caches.keys();
			await Promise.all(
				keys
					.filter((key) => key.startsWith('donor-crm-') && key !== STATIC_CACHE)
					.map((key) => caches.delete(key))
			);
			await self.clients.claim();
		})()
	);
});

self.addEventListener('message', (event) => {
	if (event.data?.type === 'SKIP_WAITING') void self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
	const request = event.request;
	if (request.method !== 'GET') return;
	const url = new URL(request.url);
	if (url.origin !== self.location.origin) return;

	if (isImmutable(url)) {
		event.respondWith(
			(async () => {
				const cached = await caches.match(request);
				if (cached) return cached;
				const response = await fetch(request);
				if (response.ok && response.type === 'basic') {
					const cache = await caches.open(STATIC_CACHE);
					await cache.put(request, response.clone());
				}
				return response;
			})()
		);
		return;
	}

	// All documents, including authenticated, donor, and payment routes, remain
	// network-only. Offline fallback is a generic explanation with no user data.
	if (request.mode === 'navigate') {
		event.respondWith(
			fetch(request).catch(async () => {
				const cache = await caches.open(STATIC_CACHE);
				return (await cache.match(OFFLINE_URL)) ?? Response.error();
			})
		);
	}
});
