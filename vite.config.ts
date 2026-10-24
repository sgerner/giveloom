import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vitest/config';
export default defineConfig({
	plugins: [tailwindcss(), sveltekit()],
	server: {
		watch: {
			ignored: [
				'**/.data/**',
				'**/test-results/**',
				'**/test-results-db/**',
				'**/playwright-report/**',
				'**/build/**',
				'**/docs/**',
				'**/tests/**',
				'**/*.md',
				'**/.github/**'
			]
		}
	},
	test: { include: ['tests/**/*.test.ts'] }
});
