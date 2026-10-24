import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import type { Readable } from 'node:stream';
import path from 'node:path';
import {
	ProviderUnavailableError,
	type BlobPutInput,
	type BlobStorage,
	type ProviderDescriptor
} from './types';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ALLOWED_MEDIA_TYPES = new Set([
	'application/pdf',
	'image/jpeg',
	'image/png',
	'image/webp',
	'text/plain'
]);
const MAX_BYTES = 25 * 1024 * 1024;

function checkMagic(bytes: Uint8Array, mediaType: string): boolean {
	if (mediaType === 'text/plain') return !bytes.includes(0);
	if (mediaType === 'application/pdf')
		return new TextDecoder().decode(bytes.slice(0, 5)) === '%PDF-';
	if (mediaType === 'image/png')
		return [137, 80, 78, 71, 13, 10, 26, 10].every((n, i) => bytes[i] === n);
	if (mediaType === 'image/jpeg')
		return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
	if (mediaType === 'image/webp')
		return (
			new TextDecoder().decode(bytes.slice(0, 4)) === 'RIFF' &&
			new TextDecoder().decode(bytes.slice(8, 12)) === 'WEBP'
		);
	return false;
}

export class FilesystemBlobStorage implements BlobStorage {
	readonly descriptor: ProviderDescriptor = {
		provider: 'filesystem',
		mode: 'production',
		capabilities: {
			api: true,
			bulkCsv: false,
			incrementalUpdates: false,
			geographicCoverage: [],
			pricing: 'free',
			licenseFlags: ['tenant-owned-files']
		}
	};
	private readonly root: string;
	private readonly signingSecret: string | undefined;

	constructor(options: { root?: string; signingSecret?: string } = {}) {
		this.root = path.resolve(options.root ?? process.env.UPLOADS_DIR ?? '/data/uploads');
		this.signingSecret = options.signingSecret ?? process.env.FILE_SIGNING_SECRET;
	}

	async put(input: BlobPutInput): Promise<{ objectId: string }> {
		if (!UUID.test(input.tenantId)) throw new TypeError('tenantId must be a UUID');
		if (input.bytes.byteLength === 0 || input.bytes.byteLength > MAX_BYTES)
			throw new RangeError(`file must be between 1 byte and ${MAX_BYTES} bytes`);
		if (!ALLOWED_MEDIA_TYPES.has(input.mediaType) || !checkMagic(input.bytes, input.mediaType))
			throw new TypeError('file type does not match an allowed media type');
		const objectId = randomUUID();
		const directory = path.join(this.root, input.tenantId);
		await mkdir(directory, { recursive: true, mode: 0o700 });
		const target = this.objectPath(input.tenantId, objectId);
		const temporary = `${target}.${randomUUID()}.tmp`;
		try {
			await writeFile(temporary, input.bytes, { flag: 'wx', mode: 0o600 });
			await rename(temporary, target);
			await writeFile(`${target}.meta`, JSON.stringify({ mediaType: input.mediaType }), {
				flag: 'wx',
				mode: 0o600
			});
		} catch (error) {
			await Promise.all([
				rm(temporary, { force: true }),
				rm(target, { force: true }),
				rm(`${target}.meta`, { force: true })
			]);
			throw error;
		}
		// The original filename is deliberately never used to construct a storage path.
		return { objectId };
	}

	async get(input: { tenantId: string; objectId: string }) {
		const target = this.objectPath(input.tenantId, input.objectId);
		const [bytes, metadata] = await Promise.all([
			readFile(target),
			readFile(`${target}.meta`, 'utf8')
		]);
		const { mediaType } = JSON.parse(metadata) as { mediaType: string };
		return { ...input, bytes, mediaType };
	}

	async getStream(input: {
		tenantId: string;
		objectId: string;
	}): Promise<{ stream: Readable; mediaType: string }> {
		const target = this.objectPath(input.tenantId, input.objectId);
		const metadata = await readFile(`${target}.meta`, 'utf8');
		const { mediaType } = JSON.parse(metadata) as { mediaType: string };
		return { stream: createReadStream(target), mediaType };
	}

	async delete(input: { tenantId: string; objectId: string }): Promise<void> {
		const target = this.objectPath(input.tenantId, input.objectId);
		await Promise.all([rm(target, { force: true }), rm(`${target}.meta`, { force: true })]);
	}

	async signedDownload(input: {
		tenantId: string;
		objectId: string;
		expiresInSeconds: number;
	}): Promise<string> {
		if (!this.signingSecret)
			throw new ProviderUnavailableError('filesystem', 'FILE_SIGNING_SECRET is not configured');
		if (
			!Number.isInteger(input.expiresInSeconds) ||
			input.expiresInSeconds < 1 ||
			input.expiresInSeconds > 3600
		)
			throw new RangeError('signed download expiry must be between 1 and 3600 seconds');
		const expires = Math.floor(Date.now() / 1000) + input.expiresInSeconds;
		const payload = `${input.tenantId}:${input.objectId}:${expires}`;
		const signature = createHmac('sha256', this.signingSecret).update(payload).digest('hex');
		return `/api/files/${input.objectId}?tenant=${encodeURIComponent(input.tenantId)}&expires=${expires}&signature=${signature}`;
	}

	static verifyDownload(input: {
		tenantId: string;
		objectId: string;
		expires: number;
		signature: string;
		secret: string;
		nowSeconds?: number;
	}): boolean {
		if (
			!UUID.test(input.tenantId) ||
			!UUID.test(input.objectId) ||
			input.expires <= (input.nowSeconds ?? Math.floor(Date.now() / 1000))
		)
			return false;
		const payload = `${input.tenantId}:${input.objectId}:${input.expires}`;
		const expected = createHmac('sha256', input.secret).update(payload).digest();
		let actual: Buffer;
		try {
			actual = Buffer.from(input.signature, 'hex');
		} catch {
			return false;
		}
		return actual.length === expected.length && timingSafeEqual(actual, expected);
	}

	private objectPath(tenantId: string, objectId: string): string {
		if (!UUID.test(tenantId) || !UUID.test(objectId))
			throw new TypeError('tenantId and objectId must be UUIDs');
		const resolved = path.resolve(this.root, tenantId, objectId);
		if (!resolved.startsWith(`${this.root}${path.sep}`))
			throw new TypeError('invalid storage path');
		return resolved;
	}
}
