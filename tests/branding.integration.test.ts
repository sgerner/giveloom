import { afterAll, describe, expect, it } from 'vitest';
import { createOwnerAccount, getPool } from '../src/lib/server/database';
import {
	getOnboardingChecklist,
	getPublicTenantBranding,
	getPublicTenantLogo,
	getTenantBranding,
	updateTenantBranding
} from '../src/lib/server/branding';
import { tenantTransaction } from '../src/lib/server/tenant-service';
import { randomUUID } from 'node:crypto';

const enabled =
	Boolean(process.env.DATABASE_URL) && process.env.RUN_POSTGRES_MUTATION_TESTS === 'true';
if (enabled) {
	process.env.CREDENTIAL_VAULT_KEY ||= Buffer.alloc(32, 28).toString('base64');
	process.env.CREDENTIAL_VAULT_KEY_ID ||= 'primary';
}
afterAll(async () => {
	if (enabled) await getPool().end();
});
async function owner() {
	const slug = `brand-${randomUUID().replaceAll('-', '').slice(0, 12)}`;
	const account = await createOwnerAccount({
		email: `${slug}@example.test`,
		name: 'Brand Owner',
		passwordHash: 'fixture',
		organizationName: 'Initial Legal Name',
		slug,
		sessionExpiresAt: new Date(Date.now() + 3600000),
		testOnlyVerifiedFixture: true
	});
	return {
		tenantId: account.tenantId,
		slug,
		userId: account.userId,
		session: { userId: account.userId, tenantSlug: slug, role: 'owner', demo: false }
	};
}

describe('tenant branding and onboarding services', () => {
	it.skipIf(!enabled)(
		'validates official themes, saves workspace fields, and restricts private tax identifiers to owners',
		async () => {
			const account = await owner();
			const initial = await getTenantBranding(account.session);
			expect(initial).toMatchObject({
				legalName: 'Initial Legal Name',
				timezone: 'UTC',
				locale: 'en-US',
				logoPublic: false
			});
			const saved = await updateTenantBranding(account.session, {
				legalName: 'Riverstone Giving',
				taxId: '12-3456789',
				timezone: 'America/Phoenix',
				locale: 'en-US',
				publicName: 'Riverstone',
				theme: 'mint',
				logoAssetId: null,
				logoPublic: false
			});
			expect(saved).toMatchObject({
				legalName: 'Riverstone Giving',
				taxId: '12-3456789',
				timezone: 'America/Phoenix',
				publicName: 'Riverstone',
				theme: 'mint'
			});
			await expect(
				updateTenantBranding(account.session, {
					legalName: saved.legalName,
					taxId: saved.taxId,
					timezone: saved.timezone,
					locale: saved.locale,
					publicName: saved.publicName,
					theme: 'invented-theme',
					logoAssetId: saved.logoAssetId,
					logoPublic: saved.logoPublic
				})
			).rejects.toMatchObject({ name: 'ZodError' });
			const other = await owner();
			await tenantTransaction(account.session, null, async (client, tenant) => {
				await client.query(
					"INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'fundraiser')",
					[tenant.id, other.userId]
				);
			});
			await expect(
				getTenantBranding({
					userId: other.userId,
					tenantSlug: account.slug,
					role: 'fundraiser',
					demo: false
				})
			).rejects.toMatchObject({ status: 403 });
		}
	);

	it.skipIf(!enabled)(
		'builds onboarding progress from persisted Stripe, SES, contact, campaign, and invitation state',
		async () => {
			const account = await owner();
			const checklist = await getOnboardingChecklist(account.session);
			const byId = new Map(checklist.steps.map((step) => [step.id, step]));
			expect(checklist).toMatchObject({ total: 6, contacts: 0, campaigns: 0, recordedGifts: 0 });
			expect(byId.get('organization')?.done).toBe(true);
			expect(byId.get('team')?.done).toBe(false);
			expect(byId.get('payments')?.done).toBe(false);
			expect(byId.get('email')?.done).toBe(false);
			expect(byId.get('contacts')?.done).toBe(false);
			expect(byId.get('campaign')?.done).toBe(false);
		}
	);

	it.skipIf(!enabled)(
		'keeps logo blobs private until explicit public branding consent and fails closed on unscanned production images',
		async () => {
			const account = await owner(),
				logoId = randomUUID(),
				objectId = randomUUID();
			await tenantTransaction(account.session, null, async (client, tenant) => {
				await client.query(
					"INSERT INTO tenant_branding_logos(tenant_id,id,object_id,media_type,size_bytes,scan_status,uploaded_by) VALUES($1,$2,$3,'image/png',32,'not_scanned',$4)",
					[tenant.id, logoId, objectId, account.userId]
				);
				await client.query(
					"UPDATE tenants SET branding=jsonb_build_object('publicName','Riverstone','logoAssetId',$2::text,'logoPublic',false) WHERE id=$1",
					[tenant.id, logoId]
				);
			});
			expect(await getPublicTenantLogo(account.slug)).toBeNull();
			const old = process.env.NODE_ENV;
			process.env.NODE_ENV = 'production';
			try {
				await tenantTransaction(account.session, null, async (client, tenant) => {
					await client.query(
						'UPDATE tenants SET branding=branding||\'{"logoPublic":true}\'::jsonb WHERE id=$1',
						[tenant.id]
					);
				});
				expect(await getPublicTenantLogo(account.slug)).toBeNull();
				await expect(
					updateTenantBranding(account.session, {
						legalName: 'Initial Legal Name',
						taxId: '',
						timezone: 'UTC',
						locale: 'en-US',
						publicName: 'Riverstone',
						theme: 'mint',
						logoAssetId: logoId,
						logoPublic: true
					})
				).rejects.toMatchObject({ status: 422 });
			} finally {
				if (old === undefined) delete process.env.NODE_ENV;
				else process.env.NODE_ENV = old;
			}
		}
	);

	it.skipIf(!enabled)(
		'returns only public name, valid theme, and consented logo URL to public pages',
		async () => {
			const account = await owner();
			await tenantTransaction(account.session, null, async (client, tenant) => {
				await client.query('UPDATE tenants SET branding=$2 WHERE id=$1', [
					tenant.id,
					{
						publicName: 'Community Fund',
						theme: 'catppuccin',
						logoAssetId: randomUUID(),
						logoPublic: false
					}
				]);
			});
			expect(await getPublicTenantBranding(account.slug)).toMatchObject({
				publicName: 'Community Fund',
				theme: 'catppuccin',
				logoUrl: null
			});
		}
	);
});
