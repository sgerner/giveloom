import { env } from '$env/dynamic/private';
import { demoModeAvailable } from '$lib/server/store';
export function load() {
	const demoAvailable = demoModeAvailable();
	const validPublicUrl = (value?: string) => {
		if (!value) return null;
		try {
			const parsed = new URL(value);
			if (parsed.username || parsed.password) return null;
			const localHttp =
				process.env.NODE_ENV !== 'production' &&
				parsed.protocol === 'http:' &&
				['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
			if (parsed.protocol !== 'https:' && !localHttp) return null;
			return parsed.origin;
		} catch {
			return null;
		}
	};
	const demoUrl = validPublicUrl(env.PUBLIC_DEMO_URL);
	const realAppUrl = validPublicUrl(env.REAL_APP_URL);
	return { demoAvailable, demoUrl, realAppUrl };
}
