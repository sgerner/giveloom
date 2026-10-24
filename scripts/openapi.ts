import { z } from 'zod';
import { createServer } from 'vite';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { mutationSchema, contactImportRowSchema, settingsSchema } from '../src/lib/server/domain';
const schemas = {
	WorkspaceMutation: z.toJSONSchema(mutationSchema),
	ContactImportRow: z.toJSONSchema(contactImportRowSchema),
	Preferences: z.toJSONSchema(settingsSchema)
};
const response = { description: 'Authorized response; errors include an actionable error string.' };
const spec = {
	openapi: '3.1.0',
	info: {
		title: 'Donor CRM API',
		version: '0.1.0',
		description:
			'Generated Zod validation contracts and implemented versioned route inventory. Provider setup and approval workflows are documented in docs/.'
	},
	servers: [{ url: '/' }],
	components: {
		securitySchemes: {
			session: { type: 'apiKey', in: 'cookie', name: 'giveloom_session' },
			portal: { type: 'apiKey', in: 'cookie', name: 'giveloom_portal' },
			bearer: {
				type: 'http',
				scheme: 'bearer',
				description: 'Tenant-scoped API token; permissions are checked on each request.'
			}
		},
		schemas
	},
	paths: {
		'/api/v1/workspace': {
			get: {
				summary: 'Read active authorized workspace',
				security: [{ session: [] }],
				responses: { '200': response, '401': response, '403': response }
			},
			post: {
				summary: 'Validate and mutate an active-tenant resource',
				security: [{ session: [] }],
				requestBody: {
					required: true,
					content: {
						'application/json': { schema: { $ref: '#/components/schemas/WorkspaceMutation' } }
					}
				},
				responses: { '201': response, '401': response, '403': response, '422': response }
			}
		},
		'/api/v1/contacts/import': {
			post: {
				summary: 'Review CSV duplicates before atomic import',
				security: [{ session: [] }],
				requestBody: {
					required: true,
					content: {
						'application/json': {
							schema: {
								type: 'object',
								required: ['tenant', 'csv'],
								properties: {
									tenant: { type: 'string' },
									csv: { type: 'string', maxLength: 1000000 },
									dryRun: { type: 'boolean', default: true }
								}
							}
						}
					}
				},
				responses: { '200': response, '409': response }
			}
		},
		'/api/v1/contacts/export': {
			get: {
				summary: 'Export authorized contacts with formula escaping',
				security: [{ session: [] }],
				responses: { '200': response, '403': response }
			}
		},
		'/api/v1/reports/{id}': {
			get: {
				summary: 'Ledger-reconciled report or permission-checked export',
				security: [{ session: [] }],
				parameters: [
					{
						name: 'id',
						in: 'path',
						required: true,
						schema: { type: 'string', enum: ['giving', 'retention'] }
					}
				],
				responses: { '200': response, '403': response }
			}
		},
		'/api/v1/research/jobs': {
			post: {
				summary: 'Preview or import uploaded IRS 990-PF evidence',
				security: [{ session: [] }],
				responses: { '200': response, '422': response }
			}
		}
	}
};
// Load the same exported Zod contracts through Vite so server-only aliases
// resolve exactly as in the application; no database connection is opened.
const server = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
try {
	const contracts = [
		['CRMCommand', 'src/lib/server/crm.ts', 'crmCommandSchema', '/api/v1/crm', 'post'],
		['GivingCommand', 'src/lib/server/giving.ts', 'givingCommandSchema', '/api/v1/giving', 'post'],
		['Workflow', 'src/lib/server/automation.ts', 'workflowSchema', null, null],
		['InsightFilter', 'src/lib/server/reporting.ts', 'insightFilterSchema', null, null]
	];
	for (const [name, file, key, path, method] of contracts) {
		const module = await server.ssrLoadModule('/' + file);
		(schemas as Record<string, unknown>)[name!] = z.toJSONSchema(module[key!]);
		if (path && method) {
			const paths = spec.paths as Record<string, any>;
			paths[path] ||= {};
			paths[path][method] = {
				summary: `Validated ${name}`,
				security: [{ session: [] }],
				requestBody: {
					required: true,
					content: { 'application/json': { schema: { $ref: `#/components/schemas/${name}` } } }
				},
				responses: { '200': response, '401': response, '403': response, '422': response }
			};
		}
	}
	async function routes(dir: string): Promise<string[]> {
		const entries = await readdir(dir, { withFileTypes: true });
		return (
			await Promise.all(
				entries.map((e) =>
					e.isDirectory()
						? routes(join(dir, e.name))
						: e.name === '+server.ts'
							? [join(dir, e.name)]
							: []
				)
			)
		).flat();
	}
	for (const file of await routes('src/routes/api/v1')) {
		const source = await readFile(file, 'utf8');
		const path =
			'/api/v1/' +
			relative('src/routes/api/v1', file)
				.replace(/\\/g, '/')
				.replace(/\/?\+server\.ts$/, '')
				.replace(/\[([^\]]+)\]/g, '{$1}');
		const paths = spec.paths as Record<string, any>;
		paths[path] ||= {};
		for (const match of source.matchAll(
			/export\s+(?:async\s+)?function\s+(GET|POST|PATCH|PUT|DELETE|HEAD)\b/g
		)) {
			const method = match[1]!.toLowerCase();
			if (paths[path][method]) continue;
			const publicAccess =
				path.includes('/public/') ||
				path.startsWith('/api/v1/webhooks/') ||
				path.startsWith('/api/v1/donation-intents') ||
				path.startsWith('/api/v1/portal/auth/') ||
				path.startsWith('/api/v1/identity/password/') ||
				path.startsWith('/api/v1/identity/verification/') ||
				path.startsWith('/api/v1/email/preferences/') ||
				path === '/api/v1/email/consent/request' ||
				path === '/api/v1/signup' ||
				path === '/api/v1/openapi.json' ||
				(path === '/api/v1/session' && method === 'post');
			paths[path][method] = {
				summary: `${match[1]} ${path}`,
				description:
					'Service validates request, token or current tenant permissions. Webhook endpoints require verified provider signatures. See feature guide for endpoint-specific approval requirements.',
				security: publicAccess
					? []
					: path.startsWith('/api/v1/portal/')
						? [{ portal: [] }]
						: [{ session: [] }],
				parameters: [...path.matchAll(/\{([^}]+)\}/g)].map((m) => ({
					name: m[1],
					in: 'path',
					required: true,
					schema: { type: 'string' }
				})),
				responses: {
					'200': response,
					'400': response,
					'401': response,
					'403': response,
					'422': response
				}
			};
		}
	}
} finally {
	await server.close();
}
for (const [path, method, scope] of [
	['/api/v1/contacts', 'get', 'contacts:read'],
	['/api/v1/contacts/{id}', 'get', 'contacts:read'],
	['/api/v1/giving', 'get', 'giving:read'],
	['/api/v1/giving', 'post', 'giving:write']
]) {
	const operation = (spec.paths as Record<string, any>)[path]?.[method];
	if (operation) {
		operation.security = [{ session: [] }, { bearer: [] }];
		operation.description =
			(operation.description || '') + ` A bearer API token requires the ${scope} permission.`;
	}
}
const json = JSON.stringify(spec, null, 2) + '\n';
await writeFile('src/lib/openapi.generated.json', json);
await writeFile('docs/openapi.generated.json', json);
console.log('Generated OpenAPI core contracts from Zod.');
