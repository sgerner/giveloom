import { z } from 'zod';
import { themes } from '$lib/themes';
import { FileApiError, scanFile } from './files';
import { tenantTransaction, ServiceError } from './tenant-service';
import { getPool } from './database';
import { FilesystemBlobStorage } from '$lib/providers/filesystem';
import { Readable } from 'node:stream';

const owners = ['owner', 'admin'] as const;
const logoStorage = new FilesystemBlobStorage();
const uuid = z.string().uuid();
const brandInput = z
	.object({
		legalName: z.string().trim().min(2).max(180),
		taxId: z.string().trim().max(40).nullable(),
		timezone: z.string().trim().min(1).max(80),
		locale: z.string().trim().min(2).max(32),
		publicName: z.string().trim().min(2).max(120),
		theme: z
			.string()
			.refine(
				(value) => themes.includes(value as (typeof themes)[number]),
				'Choose an installed Skeleton theme.'
			),
		logoAssetId: uuid.nullable(),
		logoPublic: z.boolean()
	})
	.strict();

function validateLocale(locale: string) {
	try {
		return Intl.getCanonicalLocales(locale)[0]!;
	} catch {
		throw new ServiceError('Choose a valid locale such as en-US.', 422);
	}
}

export async function getTenantBranding(session: App.Locals['session']) {
	return tenantTransaction(session, owners, async (client, tenant) => {
		const row = (
			await client.query(
				'SELECT legal_name,tax_id,timezone,locale,branding FROM tenants WHERE id=$1',
				[tenant.id]
			)
		).rows[0];
		const branding = row.branding ?? {};
		return {
			legalName: row.legal_name,
			taxId: row.tax_id ?? '',
			timezone: row.timezone,
			locale: row.locale,
			publicName: branding.publicName || row.legal_name,
			theme: themes.includes(branding.theme) ? branding.theme : themes[0],
			logoAssetId: branding.logoAssetId ?? null,
			logoPublic: branding.logoPublic === true,
			logoUrl:
				branding.logoAssetId && branding.logoPublic === true
					? `/tenant-logo/${encodeURIComponent(tenant.slug)}`
					: null
		};
	});
}

export async function updateTenantBranding(session: App.Locals['session'], input: unknown) {
	const body = brandInput.parse(input);
	let timezone: string;
	try {
		timezone = new Intl.DateTimeFormat('en-US', { timeZone: body.timezone }).resolvedOptions()
			.timeZone;
	} catch {
		throw new ServiceError('Choose a valid IANA time zone.', 422);
	}
	const locale = validateLocale(body.locale);
	if (body.logoPublic && !body.logoAssetId)
		throw new ServiceError('Upload a logo before displaying it publicly.', 422);
	return tenantTransaction(session, owners, async (client, tenant) => {
		const current = (
			await client.query('SELECT branding FROM tenants WHERE id=$1 FOR UPDATE', [tenant.id])
		).rows[0];
		if (body.logoAssetId) {
			const logo = await client.query(
				'SELECT scan_status FROM tenant_branding_logos WHERE tenant_id=$1 AND id=$2',
				[tenant.id, body.logoAssetId]
			);
			if (!logo.rowCount) throw new ServiceError('Choose a logo uploaded to this workspace.', 422);
			if (
				body.logoPublic &&
				process.env.NODE_ENV === 'production' &&
				logo.rows[0].scan_status !== 'clean'
			)
				throw new ServiceError('Only a malware-scanned logo can be displayed publicly.', 422);
		}
		const nextBranding = {
			...(current.branding ?? {}),
			publicName: body.publicName,
			theme: body.theme,
			logoAssetId: body.logoAssetId,
			logoPublic: body.logoPublic
		};
		await client.query(
			'UPDATE tenants SET legal_name=$2,tax_id=$3,timezone=$4,locale=$5,branding=$6 WHERE id=$1',
			[tenant.id, body.legalName, body.taxId || null, timezone, locale, nextBranding]
		);
		await client.query(
			"INSERT INTO audit_log(tenant_id,actor_id,action,resource,details) VALUES($1,$2,'tenant.branding.updated','tenants',$3)",
			[
				tenant.id,
				session!.userId,
				{
					changed: ['legalName', 'taxId', 'timezone', 'locale', 'branding'],
					logoPublic: body.logoPublic,
					theme: body.theme
				}
			]
		);
		return {
			legalName: body.legalName,
			taxId: body.taxId ?? '',
			timezone,
			locale,
			publicName: body.publicName,
			theme: body.theme,
			logoAssetId: body.logoAssetId,
			logoPublic: body.logoPublic,
			logoUrl: body.logoPublic ? `/tenant-logo/${encodeURIComponent(tenant.slug)}` : null
		};
	});
}

export async function storeTenantBrandLogo(
	session: App.Locals['session'],
	input: { bytes: Uint8Array; mediaType: string }
) {
	if (input.bytes.byteLength < 1 || input.bytes.byteLength > 3 * 1024 * 1024)
		throw new FileApiError('Logo must be between 1 byte and 3 MiB.', 413);
	if (!['image/jpeg', 'image/png', 'image/webp'].includes(input.mediaType))
		throw new FileApiError('Logo must be a PNG, JPEG, or WebP image.', 415);
	const tenantId = await tenantTransaction(session, owners, async (_client, tenant) => tenant.id);
	const scanStatus = await scanFile(input.bytes);
	const { objectId } = await logoStorage.put({
		tenantId,
		bytes: input.bytes,
		mediaType: input.mediaType,
		originalName: 'tenant-logo'
	});
	try {
		return await tenantTransaction(session, owners, async (client, tenant) => {
			const inserted = await client.query(
				'INSERT INTO tenant_branding_logos(tenant_id,object_id,media_type,size_bytes,scan_status,uploaded_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,media_type AS "mediaType",size_bytes AS "sizeBytes",scan_status AS "scanStatus"',
				[tenant.id, objectId, input.mediaType, input.bytes.byteLength, scanStatus, session!.userId]
			);
			await client.query(
				"INSERT INTO audit_log(tenant_id,actor_id,action,resource,record_id,details) VALUES($1,$2,'tenant.logo.uploaded','tenant_branding_logos',$3,$4)",
				[
					tenant.id,
					session!.userId,
					inserted.rows[0].id,
					{
						mediaType: input.mediaType,
						sizeBytes: input.bytes.byteLength,
						scanStatus,
						publicConsent: false
					}
				]
			);
			return inserted.rows[0];
		});
	} catch (error) {
		await logoStorage.delete({ tenantId, objectId }).catch(() => undefined);
		throw error;
	}
}

export async function getPublicTenantLogo(tenantSlug: string) {
	if (!/^[a-z0-9][a-z0-9-]{1,78}[a-z0-9]$/.test(tenantSlug)) return null;
	const pool = getPool();
	const client = await pool.connect();
	let tenantId: string | undefined;
	let logo:
		{ object_id: string; media_type: string; scan_status: string; size_bytes: number } | undefined;
	try {
		await client.query('BEGIN');
		const tenant = await client.query(
			'SELECT id,branding FROM tenants WHERE slug=$1 AND suspended_at IS NULL',
			[tenantSlug]
		);
		if (
			!tenant.rowCount ||
			tenant.rows[0].branding?.logoPublic !== true ||
			!tenant.rows[0].branding?.logoAssetId
		) {
			await client.query('COMMIT');
			return null;
		}
		tenantId = String(tenant.rows[0].id);
		await client.query("SELECT set_config('app.tenant_id',$1,true)", [tenantId]);
		const result = await client.query(
			"SELECT object_id,media_type,scan_status,size_bytes FROM tenant_branding_logos WHERE tenant_id=$1 AND id=$2 AND media_type IN ('image/jpeg','image/png','image/webp') AND size_bytes<=3145728 AND ($3::boolean=false OR scan_status='clean')",
			[tenantId, tenant.rows[0].branding.logoAssetId, process.env.NODE_ENV === 'production']
		);
		logo = result.rows[0];
		await client.query('COMMIT');
	} catch (error) {
		await client.query('ROLLBACK').catch(() => undefined);
		throw error;
	} finally {
		client.release();
	}
	if (!tenantId || !logo) return null;
	try {
		const blob = await logoStorage.getStream({ tenantId, objectId: logo.object_id });
		if (blob.mediaType !== logo.media_type) {
			blob.stream.destroy();
			return null;
		}
		return { stream: Readable.toWeb(blob.stream) as ReadableStream, mediaType: logo.media_type };
	} catch {
		return null;
	}
}

export async function getPublicTenantBranding(tenantSlug: string) {
	const row = await getPool().query(
		'SELECT slug,legal_name,timezone,locale,branding FROM tenants WHERE slug=$1 AND suspended_at IS NULL',
		[tenantSlug]
	);
	if (!row.rowCount) return null;
	const data = row.rows[0],
		branding = data.branding ?? {};
	return {
		tenant: data.slug,
		publicName:
			typeof branding.publicName === 'string' && branding.publicName.trim()
				? branding.publicName
				: data.legal_name,
		theme: themes.includes(branding.theme) ? branding.theme : themes[0],
		timezone: data.timezone,
		locale: data.locale,
		logoUrl:
			branding.logoPublic === true && branding.logoAssetId
				? `/tenant-logo/${encodeURIComponent(data.slug)}`
				: null
	};
}

export async function getOnboardingChecklist(session: App.Locals['session']) {
	return tenantTransaction(session, null, async (client, tenant) => {
		const [config, counts, members, stripe] = await Promise.all([
			client.query('SELECT provider,enabled FROM integration_configs WHERE tenant_id=$1', [
				tenant.id
			]),
			client.query(
				`SELECT (SELECT count(*)::int FROM contacts WHERE tenant_id=$1 AND archived_at IS NULL) AS contacts,(SELECT count(*)::int FROM campaigns WHERE tenant_id=$1) AS campaigns,(SELECT count(*)::int FROM gifts WHERE tenant_id=$1 AND status='recorded' AND kind<>'correction') AS gifts`,
				[tenant.id]
			),
			client.query(
				"SELECT count(*) FILTER(WHERE status='active' AND user_id<>$2)::int AS active_staff,(SELECT count(*)::int FROM identity_tokens WHERE tenant_id=$1 AND purpose='invite' AND consumed_at IS NULL AND expires_at>now()) AS pending_invites FROM memberships WHERE tenant_id=$1",
				[tenant.id, session!.userId]
			),
			client.query(
				'SELECT enabled FROM stripe_accounts WHERE tenant_id=$1 AND disconnected_at IS NULL',
				[tenant.id]
			)
		]);
		const configurations = new Map(config.rows.map((row) => [row.provider, row.enabled === true]));
		const count = counts.rows[0],
			member = members.rows[0];
		const steps = [
			{
				id: 'organization',
				title: 'Set up organization details',
				done: Boolean(tenant.name && tenant.name.trim().length > 1),
				href: `/app/${tenant.slug}/settings/general`,
				detail: 'Legal name, locale, and workspace time zone.'
			},
			{
				id: 'team',
				title: 'Invite a teammate',
				done: Number(member.active_staff) + Number(member.pending_invites) > 0,
				href: `/app/${tenant.slug}/settings/users`,
				detail: `${member.active_staff} active teammates · ${member.pending_invites} pending invitations`
			},
			{
				id: 'payments',
				title: 'Connect Stripe',
				done: stripe.rows[0]?.enabled === true,
				href: `/app/${tenant.slug}/settings/stripe`,
				detail: stripe.rows[0]?.enabled
					? 'Stripe is connected.'
					: 'Connect the workspace payment account.'
			},
			{
				id: 'email',
				title: 'Configure sender email',
				done: configurations.get('ses') === true,
				href: `/app/${tenant.slug}/settings/email`,
				detail: configurations.get('ses')
					? 'SES is enabled.'
					: 'Configure and verify a sender before sending.'
			},
			{
				id: 'contacts',
				title: 'Import or add contacts',
				done: Number(count.contacts) > 0,
				href: `/app/${tenant.slug}/contacts`,
				detail: `${count.contacts} active contacts`
			},
			{
				id: 'campaign',
				title: 'Create a campaign',
				done: Number(count.campaigns) > 0,
				href: `/app/${tenant.slug}/campaigns`,
				detail: `${count.campaigns} campaigns · ${count.gifts} recorded gifts`
			}
		];
		return {
			steps,
			completed: steps.filter((step) => step.done).length,
			total: steps.length,
			contacts: Number(count.contacts),
			campaigns: Number(count.campaigns),
			recordedGifts: Number(count.gifts)
		};
	});
}
