import { createConnection, type Socket } from 'node:net';
import { env } from '$env/dynamic/private';
import { FilesystemBlobStorage } from '$lib/providers/filesystem';
import { getPool, workspaceFromPostgres } from './database';
import type { PoolClient } from 'pg';
import { Readable } from 'node:stream';

const maxFileBytes = 25 * 1024 * 1024;
const writableRoles = new Set([
	'owner',
	'admin',
	'finance_manager',
	'fundraising_manager',
	'fundraiser'
]);
const storage = new FilesystemBlobStorage();

export type FileSession = { userId: string; tenantSlug: string; role: string };
export type FileMetadata = {
	id: string;
	name: string;
	mediaType: string;
	sizeBytes: number;
	contactId: string | null;
	scanStatus: 'clean' | 'not_scanned';
	uploadedAt: string;
};

export class FileApiError extends Error {
	constructor(
		message: string,
		readonly status: number
	) {
		super(message);
		this.name = 'FileApiError';
	}
}

async function authorize(session: FileSession, write = false) {
	if (!env.DATABASE_URL)
		throw new FileApiError('Persistent private file storage requires a database.', 503);
	const workspace = await workspaceFromPostgres(session.tenantSlug, session.userId, session.role);
	if (!workspace) throw new FileApiError('The active tenant membership is unavailable.', 403);
	if (write && !writableRoles.has(workspace.user.role))
		throw new FileApiError('Your role cannot upload contact files.', 403);
	return workspace;
}

async function tenantTransaction<T>(
	tenantId: string,
	userId: string,
	callback: (client: PoolClient) => Promise<T>
) {
	const client = await getPool().connect();
	try {
		await client.query('BEGIN');
		await client.query("SELECT set_config('app.tenant_id',$1,true)", [tenantId]);
		const membership = await client.query(
			"SELECT role FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.tenant_id=$1 AND m.user_id=$2 AND m.status='active' AND u.disabled_at IS NULL",
			[tenantId, userId]
		);
		if (!membership.rowCount)
			throw new FileApiError('The active tenant membership is unavailable.', 403);
		const result = await callback(client);
		await client.query('COMMIT');
		return result;
	} catch (error) {
		await client.query('ROLLBACK').catch(() => undefined);
		throw error;
	} finally {
		client.release();
	}
}

function metadata(row: {
	id: string;
	original_name: string;
	media_type: string;
	size_bytes: number | string;
	contact_id: string | null;
	scan_status: 'clean' | 'not_scanned';
	created_at: Date | string;
}): FileMetadata {
	return {
		id: row.id,
		name: row.original_name,
		mediaType: row.media_type,
		sizeBytes: Number(row.size_bytes),
		contactId: row.contact_id,
		scanStatus: row.scan_status,
		uploadedAt: new Date(row.created_at).toISOString()
	};
}

export function safeOriginalName(value: string) {
	const leaf = value.replace(/\\/g, '/').split('/').at(-1) ?? '';
	const safe = leaf
		.normalize('NFKC')
		.replace(/[\u0000-\u001f\u007f]/g, '')
		.replace(/[<>:"|?*]/g, '_')
		.trim()
		.slice(0, 180);
	return safe || 'attachment';
}

/** Parse the scanner's short INSTREAM result without retaining or exposing signatures. */
export function parseClamAvResponse(response: string): 'clean' | 'infected' {
	const result = response.trim().replace(/\0+$/, '');
	if (/^stream: OK$/.test(result)) return 'clean';
	if (/^stream: .+ FOUND$/.test(result)) return 'infected';
	throw new FileApiError('The malware scanner returned an invalid result.', 503);
}

async function writeBuffer(socket: Socket, buffer: Buffer) {
	await new Promise<void>((resolve, reject) => {
		const onError = (error: Error) => {
			socket.off('drain', onDrain);
			reject(error);
		};
		const onDrain = () => {
			socket.off('error', onError);
			resolve();
		};
		if (socket.write(buffer)) resolve();
		else {
			socket.once('drain', onDrain);
			socket.once('error', onError);
		}
	});
}

export async function scanFile(
	bytes: Uint8Array,
	options: { host?: string; port?: number; production?: boolean } = {}
) {
	const host = options.host ?? env.CLAMAV_HOST;
	const port = options.port ?? Number(env.CLAMAV_PORT || 3310);
	const production = options.production ?? process.env.NODE_ENV === 'production';
	if (!host) {
		if (production)
			throw new FileApiError(
				'File uploads are unavailable until a malware scanner is configured.',
				503
			);
		return 'not_scanned' as const;
	}
	if (!Number.isInteger(port) || port < 1 || port > 65535)
		throw new FileApiError('The malware scanner is misconfigured.', 503);
	return new Promise<'clean' | 'infected'>((resolve, reject) => {
		const socket = createConnection({ host, port });
		let response = '';
		let settled = false;
		const finish = (error?: Error, result?: 'clean' | 'infected') => {
			if (settled) return;
			settled = true;
			socket.destroy();
			if (error) reject(error);
			else resolve(result!);
		};
		socket.setTimeout(30_000, () =>
			finish(new FileApiError('The malware scanner timed out.', 503))
		);
		socket.on('error', () => finish(new FileApiError('The malware scanner is unavailable.', 503)));
		socket.on('close', () => {
			if (!settled) finish(new FileApiError('The malware scanner closed without a result.', 503));
		});
		socket.on('data', (chunk) => {
			response += chunk.toString('utf8');
			if (response.length > 4096)
				return finish(new FileApiError('The malware scanner returned an invalid result.', 503));
			if (response.includes('\0') || response.includes('\n')) {
				try {
					const result = parseClamAvResponse(response);
					finish(
						result === 'infected'
							? new FileApiError('The uploaded file was rejected by malware scanning.', 422)
							: undefined,
						result
					);
				} catch (error) {
					finish(
						error instanceof Error
							? error
							: new FileApiError('The malware scanner returned an invalid result.', 503)
					);
				}
			}
		});
		socket.on('connect', async () => {
			try {
				await writeBuffer(socket, Buffer.from('zINSTREAM\0'));
				for (let offset = 0; offset < bytes.byteLength; offset += 64 * 1024) {
					const chunk = Buffer.from(
						bytes.buffer,
						bytes.byteOffset + offset,
						Math.min(64 * 1024, bytes.byteLength - offset)
					);
					const length = Buffer.allocUnsafe(4);
					length.writeUInt32BE(chunk.length);
					await writeBuffer(socket, length);
					await writeBuffer(socket, chunk);
				}
				const end = Buffer.alloc(4);
				end.writeUInt32BE(0);
				await writeBuffer(socket, end);
				socket.end();
			} catch {
				finish(new FileApiError('The malware scanner is unavailable.', 503));
			}
		});
	});
}

export async function listTenantFiles(
	session: FileSession,
	filter: { contactId?: string; limit?: number } = {}
) {
	const workspace = await authorize(session);
	if (
		filter.contactId &&
		!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
			filter.contactId
		)
	)
		throw new FileApiError('contactId must be a UUID.', 400);
	const limit = Math.min(Math.max(filter.limit ?? 50, 1), 100);
	return tenantTransaction(workspace.tenant.id, session.userId, async (client) => {
		const result = await client.query(
			`SELECT id,original_name,media_type,size_bytes,contact_id,scan_status,created_at
			FROM file_objects WHERE tenant_id=$1 AND ($2::uuid IS NULL OR contact_id=$2)
			ORDER BY created_at DESC,id DESC LIMIT $3`,
			[workspace.tenant.id, filter.contactId ?? null, limit + 1]
		);
		const hasMore = result.rows.length > limit;
		const rows = hasMore ? result.rows.slice(0, limit) : result.rows;
		await client.query(
			'INSERT INTO audit_log(tenant_id,actor_id,action,resource,details) VALUES($1,$2,$3,$4,$5)',
			[workspace.tenant.id, session.userId, 'files.listed', 'files', { count: rows.length }]
		);
		return { files: rows.map(metadata), hasMore };
	});
}

export async function storeTenantFile(
	session: FileSession,
	input: { bytes: Uint8Array; mediaType: string; originalName: string; contactId?: string }
) {
	const workspace = await authorize(session, true);
	if (input.contactId) {
		await tenantTransaction(workspace.tenant.id, session.userId, async (client) => {
			const contact = await client.query(
				'SELECT 1 FROM contacts WHERE tenant_id=$1 AND id=$2 AND archived_at IS NULL',
				[workspace.tenant.id, input.contactId]
			);
			if (!contact.rowCount) throw new FileApiError('Contact not found in the active tenant.', 422);
		});
	}
	const scanStatus = await scanFile(input.bytes);
	const { objectId } = await storage.put({
		tenantId: workspace.tenant.id,
		bytes: input.bytes,
		mediaType: input.mediaType,
		originalName: input.originalName
	});
	try {
		return await tenantTransaction(workspace.tenant.id, session.userId, async (client) => {
			if (input.contactId) {
				const contact = await client.query(
					'SELECT 1 FROM contacts WHERE tenant_id=$1 AND id=$2 AND archived_at IS NULL',
					[workspace.tenant.id, input.contactId]
				);
				if (!contact.rowCount)
					throw new FileApiError('Contact not found in the active tenant.', 422);
			}
			const result = await client.query(
				`INSERT INTO file_objects(tenant_id,object_id,contact_id,original_name,media_type,size_bytes,scan_status,uploaded_by)
				VALUES($1,$2,$3,$4,$5,$6,$7,$8)
				RETURNING id,original_name,media_type,size_bytes,contact_id,scan_status,created_at`,
				[
					workspace.tenant.id,
					objectId,
					input.contactId ?? null,
					safeOriginalName(input.originalName),
					input.mediaType,
					input.bytes.byteLength,
					scanStatus,
					session.userId
				]
			);
			await client.query(
				'INSERT INTO audit_log(tenant_id,actor_id,action,resource,record_id,details) VALUES($1,$2,$3,$4,$5,$6)',
				[
					workspace.tenant.id,
					session.userId,
					'file.uploaded',
					'files',
					result.rows[0].id,
					{ mediaType: input.mediaType, sizeBytes: input.bytes.byteLength, scanStatus }
				]
			);
			return metadata(result.rows[0]);
		});
	} catch (error) {
		await storage.delete({ tenantId: workspace.tenant.id, objectId }).catch(() => undefined);
		throw error;
	}
}

export async function downloadTenantFile(session: FileSession, fileId: string) {
	if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(fileId))
		throw new FileApiError('File not found.', 404);
	const workspace = await authorize(session);
	const file = await tenantTransaction(workspace.tenant.id, session.userId, async (client) => {
		const result = await client.query(
			'SELECT id,object_id,original_name,media_type,size_bytes,contact_id,scan_status,created_at FROM file_objects WHERE tenant_id=$1 AND id=$2',
			[workspace.tenant.id, fileId]
		);
		if (!result.rowCount) throw new FileApiError('File not found.', 404);
		const row = result.rows[0];
		await client.query(
			'INSERT INTO audit_log(tenant_id,actor_id,action,resource,record_id,details) VALUES($1,$2,$3,$4,$5,$6)',
			[
				workspace.tenant.id,
				session.userId,
				'file.downloaded',
				'files',
				row.id,
				{ mediaType: row.media_type, sizeBytes: Number(row.size_bytes) }
			]
		);
		return row as {
			id: string;
			object_id: string;
			original_name: string;
			media_type: string;
			size_bytes: number;
			contact_id: string | null;
			scan_status: 'clean' | 'not_scanned';
			created_at: Date | string;
		};
	});
	if (file.scan_status !== 'clean' && process.env.NODE_ENV === 'production')
		throw new FileApiError(
			'This file is not available because it has not passed malware scanning.',
			503
		);
	let blob;
	try {
		blob = await storage.getStream({ tenantId: workspace.tenant.id, objectId: file.object_id });
	} catch {
		throw new FileApiError('File content is unavailable.', 404);
	}
	return { file: metadata(file), stream: blob.stream };
}

export async function getPublicCampaignHero(tenantSlug: string, campaignId: string) {
	if (
		!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(campaignId)
	)
		return null;
	const tenant = await getPool().query(
		'SELECT id FROM tenants WHERE slug=$1 AND suspended_at IS NULL',
		[tenantSlug]
	);
	if (!tenant.rowCount) return null;
	const client = await getPool().connect();
	let file: { object_id: string; media_type: string; scan_status: string } | null = null;
	try {
		await client.query('BEGIN');
		await client.query("SELECT set_config('app.tenant_id',$1,true)", [tenant.rows[0].id]);
		const result = await client.query(
			`SELECT f.object_id,f.media_type,f.scan_status FROM campaigns c JOIN file_objects f ON f.tenant_id=c.tenant_id AND f.id=c.hero_file_id WHERE c.tenant_id=$1 AND c.id=$2 AND c.status IN ('published','active','scheduled') AND (c.starts_at IS NULL OR c.starts_at<=now()) AND (c.ends_at IS NULL OR c.ends_at>now()) AND f.media_type IN ('image/jpeg','image/png','image/webp') AND f.size_bytes<=5242880 AND ($3::boolean=false OR f.scan_status='clean')`,
			[tenant.rows[0].id, campaignId, process.env.NODE_ENV === 'production']
		);
		if (result.rowCount) file = result.rows[0];
		await client.query('COMMIT');
	} catch (error) {
		await client.query('ROLLBACK');
		throw error;
	} finally {
		client.release();
	}
	if (!file) return null;
	try {
		const blob = await storage.getStream({
			tenantId: String(tenant.rows[0].id),
			objectId: file.object_id
		});
		if (blob.mediaType !== file.media_type) {
			blob.stream.destroy();
			return null;
		}
		return { stream: Readable.toWeb(blob.stream) as ReadableStream, mediaType: file.media_type };
	} catch {
		return null;
	}
}
