import js from '@eslint/js';
import ts from 'typescript-eslint';
import svelte from 'eslint-plugin-svelte';
// Provider boundaries intentionally discard original error causes to prevent credential leakage.
// Control-character regexes are required by filename and CSV sanitizers.
export default [
	{
		ignores: [
			'node_modules/**',
			'.svelte-kit/**',
			'build/**',
			'.data/**',
			'test-results/**',
			'playwright-report/**',
			'static/**'
		]
	},
	js.configs.recommended,
	...ts.configs.recommended,
	...svelte.configs.recommended,
	{ files: ['**/*.svelte'], languageOptions: { parserOptions: { parser: ts.parser } } },
	{
		languageOptions: {
			globals: {
				console: 'readonly',
				process: 'readonly',
				Buffer: 'readonly',
				URL: 'readonly',
				URLSearchParams: 'readonly',
				Request: 'readonly',
				Response: 'readonly',
				fetch: 'readonly',
				crypto: 'readonly',
				structuredClone: 'readonly',
				setTimeout: 'readonly',
				clearTimeout: 'readonly',
				window: 'readonly',
				document: 'readonly',
				navigator: 'readonly',
				localStorage: 'readonly',
				sessionStorage: 'readonly',
				matchMedia: 'readonly',
				history: 'readonly',
				FormData: 'readonly',
				HTMLInputElement: 'readonly',
				HTMLSelectElement: 'readonly',
				HTMLElement: 'readonly',
				requestAnimationFrame: 'readonly',
				cancelAnimationFrame: 'readonly',
				ReadableStream: 'readonly',
				TextEncoder: 'readonly',
				TextDecoder: 'readonly',
				self: 'readonly'
			}
		},
		rules: {
			'preserve-caught-error': 'off',
			'no-control-regex': 'off',
			'no-useless-assignment': 'off',
			'no-undef': 'off',
			'no-unused-vars': 'off',
			'@typescript-eslint/no-unused-vars': 'off',
			'@typescript-eslint/no-explicit-any': 'off',
			'@typescript-eslint/no-empty-object-type': 'off',
			'svelte/require-each-key': 'off',
			'svelte/prefer-svelte-reactivity': 'off',
			'svelte/no-navigation-without-resolve': 'off'
		}
	}
];
