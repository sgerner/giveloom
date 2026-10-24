import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export type CredentialContext = { tenantId: string; provider: string; credentialId: string };
export type CredentialEnvelope = string;
type EnvelopeParts = {
	version: 'v1';
	keyId: string;
	wrapNonce: string;
	wrappedKey: string;
	wrapTag: string;
	dataNonce: string;
	ciphertext: string;
	dataTag: string;
};

/** Server-only envelope encryption. A fresh data key encrypts each credential; the keyring wraps data keys. */
export class CredentialVault {
	private readonly keys = new Map<string, Buffer>();
	constructor(private readonly options: { keyring: Record<string, string>; activeKeyId: string }) {
		for (const [keyId, encoded] of Object.entries(options.keyring)) {
			const key = Buffer.from(encoded, 'base64');
			if (
				keyId.length < 1 ||
				keyId.length > 64 ||
				!/^[A-Za-z0-9_-]+$/.test(keyId) ||
				key.length !== 32 ||
				key.toString('base64').replace(/=+$/, '') !== encoded.replace(/=+$/, '')
			) {
				throw new TypeError(
					'Credential vault keys must be named and contain exactly 32 base64-encoded bytes'
				);
			}
			this.keys.set(keyId, key);
		}
		if (!this.keys.has(options.activeKeyId))
			throw new TypeError('activeKeyId must exist in the credential keyring');
	}

	encrypt(context: CredentialContext, plaintext: string): CredentialEnvelope {
		this.validateContext(context);
		if (!plaintext || plaintext.length > 64_000)
			throw new TypeError('credential must contain 1–64000 characters');
		const dataKey = randomBytes(32);
		const dataNonce = randomBytes(12);
		const wrapNonce = randomBytes(12);
		const aad = this.aad(context);
		const dataCipher = createCipheriv('aes-256-gcm', dataKey, dataNonce);
		dataCipher.setAAD(aad);
		const ciphertext = Buffer.concat([dataCipher.update(plaintext, 'utf8'), dataCipher.final()]);
		const key = this.keys.get(this.options.activeKeyId)!;
		const keyCipher = createCipheriv('aes-256-gcm', key, wrapNonce);
		keyCipher.setAAD(Buffer.concat([Buffer.from('giveloom-vault-key:v1:'), aad]));
		const wrappedKey = Buffer.concat([keyCipher.update(dataKey), keyCipher.final()]);
		const envelope: EnvelopeParts = {
			version: 'v1',
			keyId: this.options.activeKeyId,
			wrapNonce: wrapNonce.toString('base64url'),
			wrappedKey: wrappedKey.toString('base64url'),
			wrapTag: keyCipher.getAuthTag().toString('base64url'),
			dataNonce: dataNonce.toString('base64url'),
			ciphertext: ciphertext.toString('base64url'),
			dataTag: dataCipher.getAuthTag().toString('base64url')
		};
		return Buffer.from(JSON.stringify(envelope)).toString('base64url');
	}

	decrypt(context: CredentialContext, envelope: CredentialEnvelope): string {
		this.validateContext(context);
		try {
			if (!envelope || envelope.length > 100_000 || !/^[A-Za-z0-9_-]+$/.test(envelope))
				throw new Error('invalid envelope encoding');
			const value = JSON.parse(
				Buffer.from(envelope, 'base64url').toString('utf8')
			) as EnvelopeParts;
			if (value.version !== 'v1' || !this.keys.has(value.keyId)) throw new Error('unsupported key');
			const aad = this.aad(context);
			const keyDecipher = createDecipheriv(
				'aes-256-gcm',
				this.keys.get(value.keyId)!,
				Buffer.from(value.wrapNonce, 'base64url')
			);
			keyDecipher.setAAD(Buffer.concat([Buffer.from('giveloom-vault-key:v1:'), aad]));
			keyDecipher.setAuthTag(Buffer.from(value.wrapTag, 'base64url'));
			const dataKey = Buffer.concat([
				keyDecipher.update(Buffer.from(value.wrappedKey, 'base64url')),
				keyDecipher.final()
			]);
			if (dataKey.length !== 32) throw new Error('invalid key');
			const dataDecipher = createDecipheriv(
				'aes-256-gcm',
				dataKey,
				Buffer.from(value.dataNonce, 'base64url')
			);
			dataDecipher.setAAD(aad);
			dataDecipher.setAuthTag(Buffer.from(value.dataTag, 'base64url'));
			return Buffer.concat([
				dataDecipher.update(Buffer.from(value.ciphertext, 'base64url')),
				dataDecipher.final()
			]).toString('utf8');
		} catch {
			throw new Error(
				'Credential envelope is invalid, unavailable, or bound to another tenant/provider/credential'
			);
		}
	}

	rotate(context: CredentialContext, envelope: CredentialEnvelope): CredentialEnvelope {
		return this.encrypt(context, this.decrypt(context, envelope));
	}

	private validateContext(context: CredentialContext) {
		for (const [name, value] of Object.entries(context))
			if (!value || value.length > 256 || /[\u0000-\u001f]/.test(value))
				throw new TypeError(`${name} must be a non-empty identifier of at most 256 characters`);
	}

	private aad(context: CredentialContext) {
		return Buffer.from(
			JSON.stringify([
				'giveloom-credential-v1',
				context.tenantId,
				context.provider,
				context.credentialId
			])
		);
	}
}

/** Load from a secret manager or environment injection; do not commit key material. */
export function credentialVaultFromEnvironment(): CredentialVault {
	const activeKeyId = process.env.CREDENTIAL_VAULT_KEY_ID ?? 'primary';
	const ring = process.env.CREDENTIAL_VAULT_KEYRING;
	if (ring) {
		let keyring: Record<string, string>;
		try {
			const parsed = JSON.parse(ring) as unknown;
			if (
				!parsed ||
				typeof parsed !== 'object' ||
				Array.isArray(parsed) ||
				Object.values(parsed).some((value) => typeof value !== 'string')
			)
				throw new Error('invalid keyring');
			keyring = parsed as Record<string, string>;
		} catch {
			throw new Error(
				'CREDENTIAL_VAULT_KEYRING must be a JSON map of key IDs to base64-encoded 32-byte keys'
			);
		}
		return new CredentialVault({ keyring, activeKeyId });
	}
	const encoded = process.env.CREDENTIAL_VAULT_KEY;
	if (!encoded)
		throw new Error(
			'CREDENTIAL_VAULT_KEY or CREDENTIAL_VAULT_KEYRING is required for credential encryption'
		);
	return new CredentialVault({ keyring: { [activeKeyId]: encoded }, activeKeyId });
}
