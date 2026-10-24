import { defineConfig, devices } from '@playwright/test';
import { existsSync } from 'node:fs';

const chromiumExecutable =
	process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ??
	(existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : undefined);

export default defineConfig({
	testDir: './tests/e2e',
	testIgnore: ['**/pwa.spec.ts'],
	fullyParallel: false,
	workers: 1,
	forbidOnly: Boolean(process.env.CI),
	retries: process.env.CI ? 1 : 0,
	reporter: 'list',
	timeout: 120_000,
	globalTimeout: 600_000,
	expect: { timeout: 7_000 },
	use: {
		baseURL: process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:4173',
		actionTimeout: 15_000,
		navigationTimeout: 30_000,
		trace: 'retain-on-failure',
		screenshot: 'only-on-failure',
		...(chromiumExecutable ? { launchOptions: { executablePath: chromiumExecutable } } : {}),
		...devices['Desktop Chrome']
	},
	webServer: process.env.PLAYWRIGHT_BASE_URL
		? undefined
		: {
				command:
					'node tests/e2e/reset-demo-data.mjs && DEMO_DATA_PATH=.data/playwright-e2e.json DATABASE_URL= npm run dev -- --host 127.0.0.1 --port 4173',
				url: 'http://127.0.0.1:4173',
				reuseExistingServer: false,
				timeout: 120_000
			}
});
