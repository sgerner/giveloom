import { demoModeAvailable } from '$lib/server/store';
export function load() {
	return { demoAvailable: demoModeAvailable() };
}
