import { defineConfig, devices } from '@playwright/test';
import { existsSync } from 'node:fs';

const chromiumExecutable =
	process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ??
	(existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : undefined);

export default defineConfig({
	testDir: './tests/e2e',
	testMatch: '**/pwa.spec.ts',
	outputDir: '/tmp/donor-crm-pwa-results',
	fullyParallel: false,
	workers: 1,
	retries: 0,
	reporter: 'list',
	timeout: 45_000,
	expect: { timeout: 7_000 },
	use: {
		baseURL: process.env.PLAYWRIGHT_PWA_BASE_URL ?? 'http://127.0.0.1:4176',
		trace: 'off',
		screenshot: 'only-on-failure',
		...(chromiumExecutable ? { launchOptions: { executablePath: chromiumExecutable } } : {}),
		...devices['Desktop Chrome']
	},
	webServer: process.env.PLAYWRIGHT_PWA_BASE_URL
		? undefined
		: {
				command:
					'node tests/e2e/reset-demo-data.mjs && NODE_ENV=test DEMO_DATA_PATH=.data/playwright-e2e.json DATABASE_URL= npm run preview -- --host 127.0.0.1 --port 4176',
				url: 'http://127.0.0.1:4176',
				reuseExistingServer: false,
				timeout: 120_000
			}
});
