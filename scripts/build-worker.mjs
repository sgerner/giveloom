import { build } from 'esbuild';
import { resolve } from 'node:path';
await build({
	entryPoints: ['src/worker.ts'],
	outfile: 'build/worker.js',
	bundle: true,
	platform: 'node',
	target: 'node22',
	format: 'esm',
	packages: 'external',
	alias: { $lib: resolve('src/lib'), '$env/dynamic/private': resolve('scripts/worker-env.mjs') },
	sourcemap: true
});
console.log('Built standalone Node worker.');
