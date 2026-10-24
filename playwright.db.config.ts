import { defineConfig, devices } from '@playwright/test';
import { existsSync } from 'node:fs';
export default defineConfig({
	testDir: './tests/browser-db',
	outputDir: '/tmp/donor-crm-browser-db-results',
	workers: 1,
	timeout: 60000,
	globalTimeout: 600000,
	reporter: 'list',
	use: {
		baseURL: 'http://127.0.0.1:4174',
		actionTimeout: 15000,
		navigationTimeout: 30000,
		...devices['Desktop Chrome'],
		launchOptions: existsSync('/usr/bin/google-chrome')
			? { executablePath: '/usr/bin/google-chrome' }
			: {},
		trace: process.env.PLAYWRIGHT_TRACE === 'off' ? 'off' : 'retain-on-failure',
		screenshot: 'only-on-failure'
	},
	webServer: {
		command: 'npm run dev -- --host 127.0.0.1 --port 4174 --strictPort',
		url: 'http://127.0.0.1:4174',
		reuseExistingServer: false,
		timeout: 120000
	}
});
