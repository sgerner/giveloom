declare global {
	namespace App {
		interface Locals {
			session: {
				userId: string;
				tenantSlug: string;
				role: string;
				demo: boolean;
				sessionId?: string;
				sessionVersion?: number;
				expiresAt?: number;
			} | null;
		}
	}
}

export {};
