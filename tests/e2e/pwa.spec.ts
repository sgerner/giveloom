import { expect, test, type Page } from '@playwright/test';

async function openDemo(page: Page) {
	await page.goto('/');
	const demo = page.getByRole('button', { name: /explore the demo/i });
	await expect(demo).toBeEnabled();
	await demo.click();
	await expect(page).toHaveURL(/\/app\/riverstone\/overview$/);
}

test('offline app navigation shows the generic fallback and private pages stay out of Cache Storage', async ({
	page,
	context
}) => {
	await openDemo(page);
	const documentResponse = await page.goto('/app/riverstone/contacts');
	expect(documentResponse?.headers()['content-security-policy']).toContain(
		"frame-ancestors 'none'"
	);
	await expect(page.getByRole('table')).toBeVisible();
	await page.evaluate(async () => {
		if (!('serviceWorker' in navigator))
			throw new Error('Service workers are unavailable in this browser.');
		await navigator.serviceWorker.ready;
		if (!navigator.serviceWorker.controller)
			await new Promise<void>((resolve, reject) => {
				const timeout = setTimeout(
					() => reject(new Error('Service worker did not control the page.')),
					5000
				);
				navigator.serviceWorker.addEventListener(
					'controllerchange',
					() => {
						clearTimeout(timeout);
						resolve();
					},
					{ once: true }
				);
			});
	});
	const cachedUrls = await page.evaluate(async () => {
		const urls: string[] = [];
		for (const name of await caches.keys())
			for (const request of await (await caches.open(name)).keys())
				urls.push(new URL(request.url).pathname);
		return urls;
	});
	expect(cachedUrls.some((url) => url.startsWith('/app/') || url.startsWith('/api/'))).toBe(false);
	await context.setOffline(true);
	await page.goto('/app/riverstone/contacts');
	await expect(page.getByText(/never stored for offline access/i)).toBeVisible();
	await expect(page.getByRole('table')).toHaveCount(0);
});

test('reduced motion disables route animation and smooth scrolling', async ({ page }) => {
	await page.emulateMedia({ reducedMotion: 'reduce' });
	await openDemo(page);
	await page.goto('/app/riverstone/contacts');
	await expect(page.getByRole('table')).toBeVisible();
	const motion = await page.locator('main > section').evaluate((element) => {
		const style = getComputedStyle(element);
		return {
			scrollBehavior: style.scrollBehavior,
			animationDuration: style.animationDuration,
			transitionDuration: style.transitionDuration
		};
	});
	expect(motion.scrollBehavior).toBe('auto');
	expect(Number.parseFloat(motion.animationDuration)).toBeLessThanOrEqual(0.01);
	expect(Number.parseFloat(motion.transitionDuration)).toBeLessThanOrEqual(0.01);
});

test('simulated iPhone and iPad contexts show Add to Home Screen guidance without claiming install availability', async ({
	browser
}) => {
	const simulatedDevices = [
		{
			name: 'iPhone',
			userAgent:
				'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
			viewport: { width: 390, height: 844 }
		},
		{
			name: 'iPad',
			userAgent:
				'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
			viewport: { width: 820, height: 1180 }
		}
	];
	for (const device of simulatedDevices) {
		const context = await browser.newContext({
			userAgent: device.userAgent,
			isMobile: true,
			hasTouch: true,
			viewport: device.viewport
		});
		try {
			const page = await context.newPage();
			await page.goto('/');
			await expect(
				page.getByText('To add Donor CRM on iPhone or iPad, tap Share, then “Add to Home Screen.”')
			).toBeVisible();
			await expect(page.getByRole('button', { name: 'Install app' })).toHaveCount(0);
			await expect(
				page.getByRole('button', { name: 'Dismiss install instructions' })
			).toBeVisible();
		} finally {
			await context.close();
		}
	}
});

test('synthetic beforeinstallprompt waits for the user to request installation', async ({
	page
}) => {
	await page.addInitScript(() => {
		(window as Window & { __installPromptCalls?: number }).__installPromptCalls = 0;
	});
	await openDemo(page);
	await page.evaluate(() => {
		const event = new Event('beforeinstallprompt', { cancelable: true }) as Event & {
			prompt: () => Promise<void>;
			userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
		};
		event.prompt = async () => {
			const state = window as Window & { __installPromptCalls?: number };
			state.__installPromptCalls = (state.__installPromptCalls || 0) + 1;
		};
		event.userChoice = Promise.resolve({ outcome: 'accepted' });
		window.dispatchEvent(event);
	});
	await expect(page.getByRole('button', { name: 'Install app' })).toBeVisible();
	expect(
		await page.evaluate(
			() => (window as Window & { __installPromptCalls?: number }).__installPromptCalls
		)
	).toBe(0);
	await page.getByRole('button', { name: 'Install app' }).click();
	await expect(page.getByRole('button', { name: 'Install app' })).toHaveCount(0);
	expect(
		await page.evaluate(
			() => (window as Window & { __installPromptCalls?: number }).__installPromptCalls
		)
	).toBe(1);
});

test('production-built document sends the expected security policy', async ({ page }) => {
	await openDemo(page);
	const response = await page.goto('/app/riverstone/contacts');
	const headers = response?.headers() ?? {};
	expect(headers['content-security-policy']).toContain("frame-ancestors 'none'");
	expect(headers['x-content-type-options']).toBe('nosniff');
	expect(headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
});

test('a waiting service-worker update displays an explicit update prompt', async ({
	page,
	context
}) => {
	let version = 1;
	await context.route('**/service-worker.js', async (route) => {
		const current = version;
		await route.fulfill({
			status: 200,
			headers: { 'Content-Type': 'application/javascript', 'Cache-Control': 'no-cache' },
			body: `self.addEventListener('install',()=>{});self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));self.addEventListener('message',event=>{if(event.data?.type==='SKIP_WAITING')self.skipWaiting()});/*version:${current}*/`
		});
	});
	await openDemo(page);
	await page.evaluate(async () => {
		await navigator.serviceWorker.ready;
	});
	version = 2;
	await page.evaluate(async () => {
		await (await navigator.serviceWorker.getRegistration())?.update();
	});
	await expect(page.getByRole('button', { name: 'Update now' })).toBeVisible({ timeout: 15000 });
	await expect(page.getByText(/save any edits first/i)).toBeVisible();
});
