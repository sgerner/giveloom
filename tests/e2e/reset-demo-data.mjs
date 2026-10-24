import { mkdir, rm } from 'node:fs/promises';

await mkdir('.data', { recursive: true });
await rm('.data/playwright-e2e.json', { force: true });
await rm('.data/playwright-e2e.json.extensions', { recursive: true, force: true });
