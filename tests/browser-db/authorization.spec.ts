import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

const openapi = JSON.parse(
	readFileSync(new URL('../../src/lib/openapi.generated.json', import.meta.url), 'utf8')
);

// The OpenAPI handler serves public metadata and is excluded explicitly.
// The session-status route is private
// because an authenticated response contains user, tenant, and membership data.
const publicMetadataAllowlist: Record<string, string> = {
	'/api/v1/openapi.json': 'Public API metadata; excluded from the private-read authorization sweep.'
};

const documentedPublicReads: Record<string, string> = {
	'/api/v1/campaigns/public/{tenant}/{slug}': 'Published campaign metadata is public.',
	'/api/v1/events/public/{tenant}/{slug}': 'Published event metadata is public.',
	'/api/v1/events/public/{tenant}/{slug}/registration-status':
		'Public registration status uses a capability token.',
	'/api/v1/email/preferences/{token}': 'Email preference management uses a capability token.'
};

const pathValues: Record<string, string> = {
	id: '00000000-0000-4000-8000-000000000001',
	runId: '00000000-0000-4000-8000-000000000002',
	sessionId: '00000000-0000-4000-8000-000000000004',
	giftId: '00000000-0000-4000-8000-000000000003',
	tenant: 'riverstone',
	slug: 'authorization-probe',
	resource: 'organizations',
	provider: 'ses'
};

const queryDefaults = new URLSearchParams({
	tenant: 'riverstone',
	year: '2026',
	provider: 'ses',
	resource: 'organizations',
	currency: 'USD',
	limit: '1',
	from: '2026-01-01',
	to: '2026-12-31'
});

function fillPath(template: string) {
	return template.replace(/\{([^}]+)\}/g, (_, name: string) => {
		if (template === '/api/v1/reports/{id}' && name === 'id') return 'giving';
		const operation = openapi.paths[template]?.get;
		const parameter = operation?.parameters?.find(
			(item: { name: string; in: string }) => item.in === 'path' && item.name === name
		);
		const enumValue = parameter?.schema?.enum?.[0];
		return encodeURIComponent(enumValue || pathValues[name] || pathValues.id);
	});
}

const protectedGetRoutes = Object.entries(openapi.paths).flatMap(([path, item]: [string, any]) => {
	const operation = item.get;
	if (!operation?.security?.length || path in publicMetadataAllowlist) return [];
	return [{ template: path, path: fillPath(path), security: operation.security }];
});

test('unauthenticated requests cannot read OpenAPI-protected GET routes', async ({ browser }) => {
	expect(Object.keys(publicMetadataAllowlist)).toEqual(['/api/v1/openapi.json']);
	for (const [path, reason] of Object.entries(documentedPublicReads)) {
		expect(openapi.paths[path]?.get?.security || [], `${path}: ${reason}`).toEqual([]);
	}
	const protectedTemplates = protectedGetRoutes.map((route) => route.template);
	expect(protectedTemplates).toContain('/api/v1/session');
	expect(protectedTemplates).not.toContain('/api/v1/openapi.json');
	expect(protectedGetRoutes.length).toBeGreaterThan(0);

	const context = await browser.newContext();
	const violations: Array<Record<string, unknown>> = [];
	try {
		expect(await context.cookies()).toEqual([]);
		for (const route of protectedGetRoutes) {
			const url = new URL(route.path, 'http://127.0.0.1:4174');
			url.search = queryDefaults.toString();
			const response = await context.request.get(url.toString(), {
				headers: { Cookie: '', Authorization: '' }
			});
			const contentType = response.headers()['content-type'] || '';
			let payload: any;
			try {
				payload = await response.json();
			} catch {
				payload = undefined;
			}
			if (
				response.status() < 400 ||
				response.status() >= 500 ||
				!contentType.toLowerCase().includes('application/json') ||
				(typeof payload?.error !== 'string' && typeof payload?.message !== 'string')
			) {
				violations.push({
					path: route.template,
					url: url.pathname + url.search,
					security: route.security,
					status: response.status(),
					contentType,
					payload
				});
			}
		}
	} finally {
		await context.close();
	}
	expect(
		violations,
		`OpenAPI-protected GET routes that did not return a JSON 4xx error: ${JSON.stringify(violations, null, 2)}`
	).toEqual([]);
	console.info(
		`Verified ${protectedGetRoutes.length} OpenAPI-protected GET routes without session or bearer credentials.`
	);
});
