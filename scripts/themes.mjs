import { readdir, writeFile } from 'node:fs/promises';
const themes = (await readdir('node_modules/@skeletonlabs/skeleton/src/themes'))
	.filter((x) => x.endsWith('.css'))
	.map((x) => x.slice(0, -4));
await writeFile(
	'src/lib/themes.ts',
	'// Generated from the installed Skeleton package; run node scripts/themes.mjs after upgrades.\nexport const themes = ' +
		JSON.stringify(themes) +
		' as const;\n'
);
await writeFile(
	'src/themes.css',
	themes.map((x) => '@import "@skeletonlabs/skeleton/themes/' + x + '";').join('\n')
);
