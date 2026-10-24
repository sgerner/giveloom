import { createHash } from 'node:crypto';
import Redis from 'ioredis';
import { env } from '$env/dynamic/private';

let redis: Redis | undefined;
const local = new Map<string, { start: number; count: number }>();
export async function authRateLimit(
	bucket:
		| 'login'
		| 'signup'
		| 'donation'
		| 'payment-status'
		| 'portal-link'
		| 'portal-email'
		| 'identity'
		| 'mfa'
		| 'event-registration'
		| 'event-volunteer'
		| 'api',
	address: string,
	limit: number,
	windowSeconds: number
) {
	if (env.REDIS_URL) {
		try {
			redis ||= new Redis(env.REDIS_URL, {
				lazyConnect: true,
				maxRetriesPerRequest: 1,
				enableOfflineQueue: false
			});
			if (redis.status === 'wait') await redis.connect();
			const digest = createHash('sha256').update(address).digest('hex');
			const count = (await redis.eval(
				"local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],ARGV[1]); end; return n",
				1,
				`auth:limit:${bucket}:${digest}`,
				windowSeconds
			)) as number;
			return { allowed: count <= limit, available: true };
		} catch {
			if (process.env.NODE_ENV === 'production') return { allowed: false, available: false };
		}
	} else if (process.env.NODE_ENV === 'production') return { allowed: false, available: false };

	const key = `${bucket}:${address}`;
	const now = Date.now();
	const start = windowSeconds * 1000;
	const existing = local.get(key);
	if (!existing || now - existing.start >= start) {
		local.set(key, { start: now, count: 1 });
		return { allowed: true, available: true };
	}
	existing.count++;
	if (local.size > 2000)
		for (const [entry, value] of local) if (now - value.start >= start) local.delete(entry);
	return { allowed: existing.count <= limit, available: true };
}
