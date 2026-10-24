// Standalone Node worker replacement for SvelteKit's virtual private environment module.
// This file is bundled only into the server worker, never into browser assets.
export const env = process.env;
