import { json } from '@sveltejs/kit';
import argon2 from 'argon2';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { authRateLimit } from '$lib/server/auth-rate-limit';
import { createOwnerAccount } from '$lib/server/database';
import { prepareIdentityTokenMaterial } from '$lib/server/identity';
import { operatorTransactionalEmailConfigured } from '$lib/server/communications';

const schema = z
	.object({
		email: z.string().trim().email().max(254),
		password: z.string().min(12).max(128),
		name: z.string().trim().min(1).max(120),
		organizationName: z.string().trim().min(2).max(180),
		tenantSlug: z
			.string()
			.trim()
			.min(3)
			.max(48)
			.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
			.optional()
	})
	.strict();
export async function POST({ request, getClientAddress }) {
	if (!process.env.DATABASE_URL)
		return json(
			{ error: 'Account creation requires a configured persistent database.' },
			{ status: 503 }
		);
	if (!operatorTransactionalEmailConfigured())
		return json(
			{
				error:
					'Workspace sign-up requires a configured transactional email sender and public HTTPS URL.'
			},
			{ status: 503 }
		);
	const rate = await authRateLimit('signup', getClientAddress(), 5, 60 * 60);
	if (!rate.available)
		return json(
			{ error: 'Account creation protection is temporarily unavailable.' },
			{ status: 503 }
		);
	if (!rate.allowed)
		return json({ error: 'Too many account creation attempts. Try again later.' }, { status: 429 });
	let input: z.infer<typeof schema>;
	try {
		input = schema.parse(await request.json());
	} catch {
		return json(
			{ error: 'Enter a valid name, organization, email, and password (at least 12 characters).' },
			{ status: 400 }
		);
	}
	const email = input.email.toLowerCase();
	const slug =
		input.tenantSlug ||
		input.organizationName
			.toLowerCase()
			.normalize('NFKD')
			.replace(/[\u0300-\u036f]/g, '')
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-|-$/g, '')
			.slice(0, 48)
			.replace(/-$/g, '');
	if (slug.length < 3)
		return json(
			{ error: 'Choose an organization name that can make a workspace URL.' },
			{ status: 400 }
		);
	try {
		const passwordHash = await argon2.hash(input.password, {
			type: argon2.argon2id,
			memoryCost: 19456,
			timeCost: 2,
			parallelism: 1
		});
		const tenantId = randomUUID();
		const token = prepareIdentityTokenMaterial(tenantId, 'verify_email');
		const account = await createOwnerAccount({
			email,
			name: input.name,
			passwordHash,
			organizationName: input.organizationName,
			slug,
			tenantId,
			verification: {
				id: token.id,
				tokenHash: token.tokenHash,
				tokenEnvelope: token.tokenEnvelope,
				expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000)
			}
		});
		return json(
			{
				ok: true,
				emailVerificationRequired: true,
				verificationQueued: true,
				tenant: account.tenant,
				user: { id: account.userId, email: account.email, name: account.name },
				memberships: [{ ...account.tenant, role: account.role }]
			},
			{ status: 201, headers: { 'cache-control': 'private, no-store' } }
		);
	} catch (error) {
		if ((error as { code?: string })?.code === '23505')
			return json(
				{ error: 'An account or workspace with that email or workspace URL already exists.' },
				{ status: 409 }
			);
		console.error('Signup unavailable', error instanceof Error ? error.message : 'unknown error');
		return json({ error: 'Account creation is temporarily unavailable.' }, { status: 503 });
	}
}
