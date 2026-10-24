import {
	createHash,
	createHmac,
	randomBytes,
	timingSafeEqual,
	verify as verifySignature
} from 'node:crypto';
import { env } from '$env/dynamic/private';
import { SesEmailProvider } from '$lib/providers/ses';
import { credentialVaultFromEnvironment } from '$lib/providers/vault.server';
import type { Pool, PoolClient } from 'pg';
import { getPool, workspaceFromPostgres } from './database';

type Session = { userId: string; tenantSlug: string; role: string; demo?: boolean };
type Recipient = { id: string; name: string; email: string };
const sendRoles = new Set(['owner', 'admin', 'marketer']);
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const emailSigningSecret = () =>
	env.EMAIL_SIGNING_SECRET ||
	(process.env.NODE_ENV === 'test' ? 'test-email-signing-secret-with-enough-entropy-0000' : '');
function publicApplicationUrl() {
	const value = env.PUBLIC_APP_URL || process.env.PUBLIC_APP_URL;
	if (!value) return null;
	try {
		const url = new URL(value);
		if (
			!['http:', 'https:'].includes(url.protocol) ||
			url.username ||
			url.password ||
			url.search ||
			url.hash ||
			(process.env.NODE_ENV === 'production' && url.protocol !== 'https:')
		)
			return null;
		return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
	} catch {
		return null;
	}
}

export class CommunicationError extends Error {
	constructor(
		message: string,
		readonly status: number
	) {
		super(message);
		this.name = 'CommunicationError';
	}
}

export const normalizeEmail = (value: string) => value.trim().normalize('NFKC').toLowerCase();
export function eligibleEmailRecipients(
	contacts: Array<{
		id: string;
		name: string;
		email: string | null;
		data: Record<string, unknown>;
	}>,
	suppressed: Iterable<string>
): Recipient[] {
	const block = new Set(Array.from(suppressed, normalizeEmail));
	const seen = new Set<string>();
	return contacts.flatMap((contact) => {
		const email = normalizeEmail(contact.email ?? '');
		if (
			!emailPattern.test(email) ||
			contact.data?.consent !== true ||
			block.has(email) ||
			seen.has(email)
		)
			return [];
		seen.add(email);
		return [{ id: contact.id, name: String(contact.name || ''), email }];
	});
}

export function restrictEmailRecipientsToContact<T extends { id: string }>(
	recipients: T[],
	contactId?: string | null
): T[] {
	return contactId ? recipients.filter((recipient) => recipient.id === contactId) : recipients;
}

export function assignCampaignEmailVariants(
	recipients: Array<{ id: string; email: string }>,
	seed: string
): Record<string, 'A' | 'B'> {
	const ids = new Set<string>();
	const emails = new Set<string>();
	const assignments: Record<string, 'A' | 'B'> = {};
	for (const recipient of recipients) {
		const email = normalizeEmail(recipient.email);
		if (ids.has(recipient.id) || emails.has(email))
			throw new CommunicationError('A campaign email recipient may only be assigned once.', 409);
		ids.add(recipient.id);
		emails.add(email);
		assignments[recipient.id] =
			createHmac('sha256', seed).update(recipient.id).digest().readUInt32BE(0) % 2 === 0
				? 'A'
				: 'B';
	}
	return assignments;
}

export function verifySnsSignature(
	message: Record<string, unknown>,
	certificatePem: string
): boolean {
	const signature = message.Signature;
	const version = message.SignatureVersion;
	if (typeof signature !== 'string' || !['1', '2'].includes(String(version))) return false;
	const fields =
		message.Type === 'Notification'
			? ['Message', 'MessageId', 'Subject', 'Timestamp', 'TopicArn', 'Type']
			: message.Type === 'SubscriptionConfirmation' || message.Type === 'UnsubscribeConfirmation'
				? ['Message', 'MessageId', 'SubscribeURL', 'Timestamp', 'Token', 'TopicArn', 'Type']
				: [];
	const canonical = fields
		.filter(
			(field) =>
				typeof message[field] === 'string' && !(field === 'Subject' && message[field] === '')
		)
		.map((field) => `${field}\n${String(message[field])}\n`)
		.join('');
	if (!canonical || typeof message.SigningCertURL !== 'string') return false;
	try {
		const url = new URL(message.SigningCertURL);
		if (
			url.protocol !== 'https:' ||
			!/^sns\.[a-z0-9-]+\.amazonaws\.com(?:\.cn)?$/.test(url.hostname) ||
			!/^\/SimpleNotificationService-[A-Za-z0-9_-]+\.pem$/.test(url.pathname) ||
			url.search ||
			url.hash ||
			url.username ||
			url.password
		)
			return false;
		return verifySignature(
			version === '1' ? 'RSA-SHA1' : 'RSA-SHA256',
			Buffer.from(canonical),
			certificatePem,
			Buffer.from(signature, 'base64')
		);
	} catch {
		return false;
	}
}

async function tenantContext(session: Session, write = false, compact = false) {
	if (!env.DATABASE_URL)
		throw new CommunicationError('Email sending requires persistent storage.', 503);
	if (!session || !sendRoles.has(session.role))
		throw new CommunicationError(
			'Only owners, administrators, and marketers may manage email sends.',
			403
		);
	const workspace = await workspaceFromPostgres(
		session.tenantSlug,
		session.userId,
		session.role,
		compact ? { compact: true } : undefined
	);
	if (!workspace) throw new CommunicationError('Active tenant membership is unavailable.', 403);
	if (write) {
		const configured = await withTenant(workspace.tenant.id, session.userId, async (client) => {
			const row = await client.query(
				"SELECT enabled FROM integration_configs WHERE tenant_id=$1 AND provider='ses' AND credential_id='primary'",
				[workspace.tenant.id]
			);
			return Boolean(row.rows[0]?.enabled);
		});
		if (!configured)
			throw new CommunicationError('Verified SES sending is not enabled for this tenant.', 409);
	}
	return workspace;
}

async function withTenant<T>(
	tenantId: string,
	userId: string | null,
	callback: (client: PoolClient) => Promise<T>,
	pool: Pool = getPool()
): Promise<T> {
	const client = await pool.connect();
	try {
		await client.query('BEGIN');
		await client.query("SELECT set_config('app.tenant_id',$1,true)", [tenantId]);
		if (userId) {
			const member = await client.query(
				"SELECT m.role FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.tenant_id=$1 AND m.user_id=$2 AND m.status='active' AND u.disabled_at IS NULL",
				[tenantId, userId]
			);
			if (!member.rowCount)
				throw new CommunicationError('Active tenant membership is unavailable.', 403);
		}
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

export function contentHash(subject: string, body: string, html = '') {
	return createHash('sha256')
		.update(JSON.stringify([subject, body, html]))
		.digest('hex');
}
function campaignVariantHash(snapshot: {
	campaignId: string;
	subjects: { A: string; B: string };
	seed: string;
	assignments: Record<string, 'A' | 'B'>;
}) {
	const frozen = JSON.stringify([
		snapshot.campaignId,
		snapshot.subjects.A,
		snapshot.subjects.B,
		snapshot.seed,
		Object.entries(snapshot.assignments).sort(([a], [b]) => a.localeCompare(b))
	]);
	return createHash('sha256').update(frozen).digest('hex');
}
const htmlEscape = (value: string) =>
	value.replace(
		/[&<>"']/g,
		(char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!
	);
const emailTags = new Set([
	'a',
	'abbr',
	'b',
	'blockquote',
	'br',
	'caption',
	'code',
	'div',
	'em',
	'h1',
	'h2',
	'h3',
	'hr',
	'i',
	'img',
	'li',
	'ol',
	'p',
	'pre',
	's',
	'small',
	'span',
	'strong',
	'sub',
	'sup',
	'table',
	'tbody',
	'td',
	'th',
	'thead',
	'tr',
	'u',
	'ul'
]);
const voidEmailTags = new Set(['br', 'hr', 'img']);
const emailCssProperties = new Set([
	'background-color',
	'border',
	'border-color',
	'border-radius',
	'border-style',
	'border-width',
	'color',
	'font-family',
	'font-size',
	'font-style',
	'font-weight',
	'height',
	'line-height',
	'margin',
	'margin-bottom',
	'margin-left',
	'margin-right',
	'margin-top',
	'max-width',
	'padding',
	'padding-bottom',
	'padding-left',
	'padding-right',
	'padding-top',
	'text-align',
	'text-decoration',
	'vertical-align',
	'width'
]);
function safeEmailStyle(value: string) {
	return value
		.split(';')
		.flatMap((declaration) => {
			const split = declaration.indexOf(':');
			if (split < 1) return [];
			const property = declaration.slice(0, split).trim().toLowerCase();
			const content = declaration.slice(split + 1).trim();
			if (
				!emailCssProperties.has(property) ||
				!content ||
				/(?:url\s*\(|expression\s*\(|@import|javascript:|[<>])/i.test(content)
			)
				return [];
			return [`${property}:${content}`];
		})
		.join(';');
}
/** Strict allowlist sanitizer for authored email markup. Unknown tags and attributes are discarded. */
export function sanitizeEmailHtml(source: string) {
	const stripped = source
		.replace(/<!--[\s\S]*?-->/g, '')
		.replace(
			/<(script|style|iframe|object|embed|svg|math|form|input|button|link|meta|base)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,
			''
		)
		.replace(
			/<(script|style|iframe|object|embed|svg|math|form|input|button|link|meta|base)\b[^>]*\/?\s*>/gi,
			''
		);
	return stripped.replace(
		/<\/?([a-zA-Z0-9]+)\b([^>]*)>/g,
		(raw, rawName: string, attributes: string) => {
			const name = rawName.toLowerCase();
			if (!emailTags.has(name)) return '';
			const closing = raw.startsWith('</');
			if (closing) return voidEmailTags.has(name) ? '' : `</${name}>`;
			const attrs: string[] = [];
			const matcher = /([a-zA-Z-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
			let match: RegExpExecArray | null;
			while ((match = matcher.exec(attributes))) {
				const key = match[1]!.toLowerCase();
				const value = match[2] ?? match[3] ?? match[4] ?? '';
				if (key === 'style') {
					const style = safeEmailStyle(value);
					if (style) attrs.push(`style="${htmlEscape(style)}"`);
					continue;
				}
				if (
					['title', 'align', 'width', 'height', 'alt', 'role', 'dir', 'lang', 'bgcolor'].includes(
						key
					) &&
					/^[^<>\u0000-\u001f]{0,500}$/.test(value)
				) {
					attrs.push(`${key}="${htmlEscape(value)}"`);
					continue;
				}
				if (
					(key === 'href' || key === 'src') &&
					value.length <= 2048 &&
					!/^\s*(?:javascript|data|vbscript):/i.test(value) &&
					/^(?:https?:|mailto:|\/|#)/i.test(value)
				) {
					attrs.push(`${key}="${htmlEscape(value)}"`);
					if (key === 'href') attrs.push('rel="noopener noreferrer"');
				}
			}
			return `<${name}${attrs.length ? ` ${attrs.join(' ')}` : ''}${voidEmailTags.has(name) ? ' />' : '>'}`;
		}
	);
}
export function plainTextFromEmailHtml(html: string) {
	return html
		.replace(/<(br|hr)\b[^>]*>/gi, '\n')
		.replace(/<\/(p|div|li|h[1-6]|tr)\s*>/gi, '\n')
		.replace(/<[^>]*>/g, '')
		.replace(/&nbsp;/gi, ' ')
		.replace(/&amp;/gi, '&')
		.replace(/&lt;/gi, '<')
		.replace(/&gt;/gi, '>')
		.replace(/&quot;/gi, '"')
		.replace(/&#39;/gi, "'")
		.replace(/[ \t]+\n/g, '\n')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}
async function sesEligibleRecipients(
	provider: SesEmailProvider,
	recipients: Recipient[],
	productionAccessEnabled: boolean
) {
	if (productionAccessEnabled) return recipients;
	const checked = await Promise.all(
		recipients.map(async (recipient) => ({
			recipient,
			verified: await provider.verifyRecipientIdentity(recipient.email)
		}))
	);
	return checked.filter((item) => item.verified).map((item) => item.recipient);
}
function interpolate(value: string, recipient: Recipient) {
	return value.replace(
		/\{\{\s*(name|preferredName|firstName|email)\s*\}\}/gi,
		(_, field: string) =>
			field.toLowerCase() === 'email'
				? recipient.email
				: field.toLowerCase() === 'name'
					? recipient.name
					: (recipient.name.split(/\s+/)[0] ?? 'there')
	);
}
function interpolateHtml(value: string, recipient: Recipient) {
	return sanitizeEmailHtml(
		value.replace(/\{\{\s*(name|preferredName|firstName|email)\s*\}\}/gi, (_, field: string) =>
			htmlEscape(
				field.toLowerCase() === 'email'
					? recipient.email
					: field.toLowerCase() === 'name'
						? recipient.name
						: (recipient.name.split(/\s+/)[0] ?? 'there')
			)
		)
	);
}

async function getSesCredentials(tenantId: string, client: PoolClient) {
	const result = await client.query(
		"SELECT credential_envelope,enabled FROM integration_configs WHERE tenant_id=$1 AND provider='ses' AND credential_id='primary'",
		[tenantId]
	);
	if (!result.rowCount || !result.rows[0].enabled)
		throw new CommunicationError('Verified SES sending is not enabled for this tenant.', 409);
	try {
		const config = JSON.parse(
			credentialVaultFromEnvironment().decrypt(
				{ tenantId, provider: 'ses', credentialId: 'primary' },
				result.rows[0].credential_envelope
			)
		) as {
			region: string;
			fromAddress: string;
			accessKeyId: string;
			secretAccessKey: string;
			sessionToken?: string;
		};
		if (!config.region || !config.fromAddress || !config.accessKeyId || !config.secretAccessKey)
			throw new Error('missing field');
		return config;
	} catch {
		throw new CommunicationError('Stored SES credentials are unavailable.', 503);
	}
}

export function segmentMatches(contact: Record<string, any>, rules: unknown) {
	if (!Array.isArray(rules)) return false;
	return rules.every((raw) => {
		if (!raw || typeof raw !== 'object') return false;
		const rule = raw as { field?: unknown; operator?: unknown; value?: unknown };
		if (typeof rule.field !== 'string') return false;
		const value = rule.field.startsWith('data.')
			? contact.data?.[rule.field.slice(5)]
			: rule.field === 'consent'
				? contact.data?.consent
				: contact[rule.field];
		const expected = rule.value;
		if (rule.operator === 'is_empty')
			return (
				value === null ||
				value === undefined ||
				value === '' ||
				(Array.isArray(value) && !value.length)
			);
		if (rule.operator === 'equals')
			return String(value ?? '').toLowerCase() === String(expected ?? '').toLowerCase();
		if (rule.operator === 'contains')
			return Array.isArray(value)
				? value.some((item) => String(item).toLowerCase() === String(expected ?? '').toLowerCase())
				: String(value ?? '')
						.toLowerCase()
						.includes(String(expected ?? '').toLowerCase());
		if (rule.operator === 'greater_than' || rule.operator === 'less_than') {
			const a = Number(value),
				b = Number(expected);
			return (
				Number.isFinite(a) &&
				Number.isFinite(b) &&
				(rule.operator === 'greater_than' ? a > b : a < b)
			);
		}
		return false;
	});
}
export function scheduledEmailSnapshotHash(snapshot: {
	emailId: string;
	segmentId: string | null;
	scheduledAt: string;
	fromAddress: string;
	subject: string;
	body: string;
	html: string;
	recipients: Array<[string, string, string]>;
}) {
	const recipients = [...snapshot.recipients].sort((a, b) => a[0].localeCompare(b[0]));
	return createHash('sha256')
		.update(
			JSON.stringify([
				snapshot.emailId,
				snapshot.segmentId,
				new Date(snapshot.scheduledAt).toISOString(),
				snapshot.fromAddress,
				snapshot.subject,
				snapshot.body,
				snapshot.html,
				recipients
			])
		)
		.digest('hex');
}
async function readEligible(
	client: PoolClient,
	tenantId: string,
	segmentId?: string | null,
	contactId?: string | null
) {
	const [contacts, suppressions] = await Promise.all([
		client.query(
			'SELECT id,name,email,data,stage,tags,created_at AS "createdAt" FROM contacts WHERE tenant_id=$1 AND archived_at IS NULL AND email IS NOT NULL ORDER BY id',
			[tenantId]
		),
		client.query('SELECT email FROM email_suppressions WHERE tenant_id=$1', [tenantId])
	]);
	let contactsToCheck = contacts.rows as Array<Record<string, any>>;
	if (contactId) contactsToCheck = contactsToCheck.filter((contact) => contact.id === contactId);
	if (segmentId) {
		const segment = await client.query(
			"SELECT data FROM workspace_records WHERE tenant_id=$1 AND resource='segments' AND id=$2 AND archived_at IS NULL",
			[tenantId, segmentId]
		);
		if (!segment.rowCount)
			throw new CommunicationError('Recipient segment not found in the active tenant.', 404);
		const rules = segment.rows[0].data?.rules;
		contactsToCheck = contactsToCheck.filter((contact) => segmentMatches(contact, rules));
	}
	return restrictEmailRecipientsToContact(
		eligibleEmailRecipients(
			contactsToCheck as Array<{
				id: string;
				name: string;
				email: string;
				data: Record<string, unknown>;
			}>,
			suppressions.rows.map((row) => row.email as string)
		),
		contactId
	);
}

export async function workflowDraftContact(client: PoolClient, tenantId: string, emailId: string) {
	const result = await client.query(
		"SELECT contact_id FROM automation_action_approvals WHERE tenant_id=$1 AND draft_id=$2 AND status='approved'",
		[tenantId, emailId]
	);
	return result.rows[0]?.contact_id as string | undefined;
}

function getDraft(workspace: { emails: Array<Record<string, unknown>> }, emailId: string) {
	const draft = workspace.emails.find((item) => item.id === emailId);
	if (!draft) throw new CommunicationError('Email draft not found in the active tenant.', 404);
	const subject = String(draft.subject ?? '').trim();
	const html = sanitizeEmailHtml(String(draft.htmlBody ?? ''));
	const body = String(draft.body ?? draft.text ?? '').trim() || plainTextFromEmailHtml(html);
	if (!subject || subject.length > 998 || (!body && !html) || body.length > 95_000)
		throw new CommunicationError(
			'Add a subject and message content before previewing this email.',
			422
		);
	if (draft.status && !['draft', 'review'].includes(String(draft.status)))
		throw new CommunicationError('This email is not in a sendable draft state.', 409);
	return { draft, subject, body, html };
}

function decodeEmailDraftCursor(value?: string | null) {
	if (!value) return null;
	if (value.length > 512) throw new CommunicationError('Email draft cursor is invalid.', 400);
	try {
		const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
		if (
			!Array.isArray(parsed) ||
			parsed.length !== 2 ||
			typeof parsed[0] !== 'string' ||
			!Number.isFinite(Date.parse(parsed[0])) ||
			typeof parsed[1] !== 'string' ||
			!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(parsed[1])
		)
			throw new Error('invalid cursor');
		return { updatedAt: parsed[0], id: parsed[1] };
	} catch {
		throw new CommunicationError('Email draft cursor is invalid.', 400);
	}
}

export async function listEmailDrafts(
	session: Session,
	options: { cursor?: string | null; limit?: number; draftId?: string | null } = {}
) {
	if (!session) throw new CommunicationError('Sign in before viewing email.', 401);
	if (session.demo)
		return {
			emails: [],
			draft: undefined,
			nextCursor: null,
			templates: [],
			batches: [],
			sendingEnabled: false
		};
	if (
		options.draftId &&
		!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
			options.draftId
		)
	)
		throw new CommunicationError('Email draft not found.', 404);
	if (options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit < 1))
		throw new CommunicationError('Email draft page size is invalid.', 400);
	const workspace = await tenantContext(session, false, true);
	const cursor = decodeEmailDraftCursor(options.cursor);
	const limit = Math.min(100, options.limit ?? 50);
	return withTenant(workspace.tenant.id, session.userId, async (client) => {
		let draft;
		let emails: Record<string, unknown>[] = [];
		let nextCursor: string | null = null;
		if (options.draftId) {
			const selected = await client.query(
				'SELECT id,data,created_at AS "createdAt",updated_at AS "updatedAt" FROM workspace_records WHERE tenant_id=$1 AND resource=\'emails\' AND id=$2 AND archived_at IS NULL',
				[workspace.tenant.id, options.draftId]
			);
			if (!selected.rowCount) throw new CommunicationError('Email draft not found.', 404);
			draft = {
				...selected.rows[0].data,
				id: selected.rows[0].id,
				createdAt: selected.rows[0].createdAt,
				updatedAt: selected.rows[0].updatedAt
			};
		} else {
			const listed = await client.query(
				"SELECT id,data->>'subject' AS subject,coalesce(data->>'status','draft') AS status,updated_at AS \"updatedAt\",updated_at::text AS \"cursorTime\" FROM workspace_records WHERE tenant_id=$1 AND resource='emails' AND archived_at IS NULL AND ($2::timestamptz IS NULL OR updated_at<$2::timestamptz OR (updated_at=$2::timestamptz AND id<$3::uuid)) ORDER BY updated_at DESC,id DESC LIMIT $4",
				[workspace.tenant.id, cursor?.updatedAt || null, cursor?.id || null, limit + 1]
			);
			const hasMore = listed.rows.length > limit;
			emails = listed.rows.slice(0, limit);
			const last = emails.at(-1);
			if (hasMore && last)
				nextCursor = Buffer.from(JSON.stringify([last.cursorTime, last.id])).toString('base64url');
		}
		const batches = await client.query(
			`SELECT b.id,b.email_id AS "emailId",b.status,b.recipient_count AS "recipientCount",b.created_at AS "createdAt",
			count(m.id)::int AS "queuedCount",count(m.id) FILTER(WHERE m.status IN ('accepted','delivered'))::int AS "sentCount",
			count(m.id) FILTER(WHERE m.status IN ('suppressed','bounced','complained','uncertain','failed'))::int AS "issueCount",
			b.scheduled_at AS "scheduledAt",b.scheduled_timezone AS "scheduledTimeZone",b.opened_count AS "opens",b.clicked_count AS "clicks",
			CASE WHEN b.opened_count>0 THEN 'unreliable aggregate opens' ELSE NULL END AS "engagementNote"
			FROM email_send_batches b LEFT JOIN email_messages m ON m.tenant_id=b.tenant_id AND m.batch_id=b.id
			WHERE b.tenant_id=$1 GROUP BY b.id ORDER BY b.created_at DESC LIMIT 100`,
			[workspace.tenant.id]
		);
		const enabled = await client.query(
			"SELECT enabled FROM integration_configs WHERE tenant_id=$1 AND provider='ses' AND credential_id='primary'",
			[workspace.tenant.id]
		);
		const templates = await client.query(
			`SELECT id,name,subject,html_body AS "htmlBody",text_body AS "textBody",variables,created_at AS "createdAt",updated_at AS "updatedAt" FROM email_templates WHERE tenant_id=$1 ORDER BY updated_at DESC LIMIT 100`,
			[workspace.tenant.id]
		);
		return {
			emails,
			draft,
			nextCursor,
			batches: batches.rows,
			templates: templates.rows,
			sendingEnabled: Boolean(enabled.rows[0]?.enabled)
		};
	});
}

export async function campaignEmailVariantResults(session: Session, campaignId: string) {
	if (!/^[0-9a-f-]{36}$/i.test(campaignId))
		throw new CommunicationError('Campaign not found.', 404);
	const workspace = await tenantContext(session);
	return withTenant(workspace.tenant.id, session.userId, async (client) => {
		const campaign = await client.query('SELECT id FROM campaigns WHERE tenant_id=$1 AND id=$2', [
			workspace.tenant.id,
			campaignId
		]);
		if (!campaign.rowCount) throw new CommunicationError('Campaign not found.', 404);
		const rows = await client.query(
			`SELECT m.campaign_variant AS variant,m.subject,count(*)::int AS assigned,
		count(*) FILTER(WHERE m.status IN ('accepted','delivered'))::int AS sent,
		count(*) FILTER(WHERE m.status='delivered')::int AS delivered,
		count(*) FILTER(WHERE m.status='bounced')::int AS bounced,
		count(*) FILTER(WHERE m.status='complained')::int AS complained,
		count(*) FILTER(WHERE m.status IN ('failed','uncertain','suppressed'))::int AS issues
		FROM email_messages m WHERE m.tenant_id=$1 AND m.campaign_id=$2 AND m.campaign_variant IS NOT NULL
		GROUP BY m.campaign_variant,m.subject ORDER BY m.campaign_variant,m.subject`,
			[workspace.tenant.id, campaignId]
		);
		return { variants: rows.rows };
	});
}

export async function saveEmailTemplate(
	session: Session,
	input: {
		id?: string;
		name: string;
		subject: string;
		htmlBody: string;
		textBody?: string;
		variables?: unknown[];
	}
) {
	const workspace = await tenantContext(session, false);
	const name = input.name.trim();
	const subject = input.subject.trim();
	const html = sanitizeEmailHtml(input.htmlBody);
	const text = (input.textBody?.trim() || plainTextFromEmailHtml(html)).trim();
	if (
		!name ||
		name.length > 180 ||
		!subject ||
		subject.length > 998 ||
		!text ||
		text.length > 95000 ||
		html.length > 100000
	)
		throw new CommunicationError(
			'Template name, subject, and message content must be within their allowed lengths.',
			422
		);
	return withTenant(workspace.tenant.id, session.userId, async (client) => {
		if (input.id) {
			const result = await client.query(
				`UPDATE email_templates SET name=$3,subject=$4,html_body=$5,text_body=$6,variables=$7,updated_by=$8,updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING id,name,subject,html_body AS "htmlBody",text_body AS "textBody",variables,updated_at AS "updatedAt"`,
				[
					workspace.tenant.id,
					input.id,
					name,
					subject,
					html,
					text,
					JSON.stringify(input.variables ?? []),
					session.userId
				]
			);
			if (!result.rowCount) throw new CommunicationError('Email template not found.', 404);
			await client.query(
				"INSERT INTO audit_log(tenant_id,actor_id,action,resource,record_id,details) VALUES($1,$2,'email.template_updated','email_templates',$3,$4)",
				[workspace.tenant.id, session.userId, input.id, { name }]
			);
			return result.rows[0];
		}
		const result = await client.query(
			`INSERT INTO email_templates(tenant_id,name,subject,html_body,text_body,variables,created_by,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7,$7) RETURNING id,name,subject,html_body AS "htmlBody",text_body AS "textBody",variables,created_at AS "createdAt",updated_at AS "updatedAt"`,
			[
				workspace.tenant.id,
				name,
				subject,
				html,
				text,
				JSON.stringify(input.variables ?? []),
				session.userId
			]
		);
		await client.query(
			"INSERT INTO audit_log(tenant_id,actor_id,action,resource,record_id,details) VALUES($1,$2,'email.template_created','email_templates',$3,$4)",
			[workspace.tenant.id, session.userId, result.rows[0].id, { name }]
		);
		return result.rows[0];
	});
}
export async function deleteEmailTemplate(session: Session, id: string) {
	const workspace = await tenantContext(session, false);
	return withTenant(workspace.tenant.id, session.userId, async (client) => {
		const result = await client.query('DELETE FROM email_templates WHERE tenant_id=$1 AND id=$2', [
			workspace.tenant.id,
			id
		]);
		if (!result.rowCount) throw new CommunicationError('Email template not found.', 404);
		await client.query(
			"INSERT INTO audit_log(tenant_id,actor_id,action,resource,record_id,details) VALUES($1,$2,'email.template_deleted','email_templates',$3,'{}')",
			[workspace.tenant.id, session.userId, id]
		);
		return { deleted: true };
	});
}

export async function requestEmailConsent(
	tenantSlug: string,
	emailInput: string,
	contactId?: string,
	requesterIp?: string
) {
	const email = normalizeEmail(emailInput);
	if (!emailPattern.test(email) || email.length > 254)
		throw new CommunicationError('Enter a valid email address.', 422);
	const pool = getPool();
	const tenant = await pool.query('SELECT id FROM tenants WHERE slug=$1', [tenantSlug]);
	if (!tenant.rowCount) return { accepted: true };
	const tenantId = String(tenant.rows[0].id);
	await withTenant(tenantId, null, async (client) => {
		if (requesterIp) {
			const secret = emailSigningSecret();
			if (!secret)
				throw new CommunicationError('Email request rate limiting is not configured.', 503);
			const requesterHash = createHmac('sha256', secret).update(requesterIp).digest('hex');
			const limit = await client.query(
				`INSERT INTO email_consent_request_limits(tenant_id,requester_hash,attempts) VALUES($1,$2,1) ON CONFLICT(tenant_id,requester_hash) DO UPDATE SET attempts=CASE WHEN email_consent_request_limits.window_started_at<now()-interval '1 hour' THEN 1 ELSE email_consent_request_limits.attempts+1 END,window_started_at=CASE WHEN email_consent_request_limits.window_started_at<now()-interval '1 hour' THEN now() ELSE email_consent_request_limits.window_started_at END RETURNING attempts`,
				[tenantId, requesterHash]
			);
			if (limit.rows[0].attempts > 20) return;
		}
		const contact = await client.query(
			'SELECT id,data FROM contacts WHERE tenant_id=$1 AND lower(email)=lower($2) AND archived_at IS NULL AND ($3::uuid IS NULL OR id=$3) ORDER BY id LIMIT 1',
			[tenantId, email, contactId ?? null]
		);
		if (!contact.rowCount || contact.rows[0].data?.consent === true) return;
		const suppression = await client.query(
			'SELECT reason FROM email_suppressions WHERE tenant_id=$1 AND email=$2',
			[tenantId, email]
		);
		if (['bounce', 'complaint', 'manual'].includes(suppression.rows[0]?.reason)) return;
		const recent = await client.query(
			"SELECT count(*)::int AS count FROM email_consent_requests WHERE tenant_id=$1 AND contact_id=$2 AND created_at>now()-interval '24 hours'",
			[tenantId, contact.rows[0].id]
		);
		if (recent.rows[0].count >= 3) return;
		const id = crypto.randomUUID();
		const token = randomBytes(32).toString('base64url');
		const envelope = credentialVaultFromEnvironment().encrypt(
			{ tenantId, provider: 'email-consent', credentialId: id },
			token
		);
		const expiresAt = new Date(Date.now() + 48 * 60 * 60_000);
		await client.query(
			'INSERT INTO email_consent_requests(id,tenant_id,contact_id,email,token_hash,token_envelope,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7)',
			[
				id,
				tenantId,
				contact.rows[0].id,
				email,
				createHash('sha256').update(token).digest('hex'),
				envelope,
				expiresAt
			]
		);
		await client.query(
			"INSERT INTO outbox_events(tenant_id,event_type,payload,idempotency_key) VALUES($1,'email.consent_request',$2,$3) ON CONFLICT(idempotency_key) DO NOTHING",
			[tenantId, { requestId: id }, `email.consent:${id}`]
		);
	});
	return { accepted: true };
}

export async function handleEmailConsentOutboxEvent(
	event: EmailJob,
	pool: Pool,
	send: typeof sendTransactionalEmail
) {
	const payload = event.payload as { requestId?: unknown };
	if (typeof payload.requestId !== 'string') throw new Error('Email consent event is invalid');
	const requestId = payload.requestId;
	const request = await withTenant(event.tenantId, null, async (client) => {
		const result = await client.query(
			'SELECT r.*,c.name FROM email_consent_requests r JOIN contacts c ON c.tenant_id=r.tenant_id AND c.id=r.contact_id WHERE r.tenant_id=$1 AND r.id=$2 FOR UPDATE OF r',
			[event.tenantId, requestId]
		);
		if (
			!result.rowCount ||
			!['pending', 'queued'].includes(result.rows[0].status) ||
			new Date(result.rows[0].expires_at) <= new Date()
		)
			return null;
		await client.query(
			"UPDATE email_consent_requests SET status='queued' WHERE tenant_id=$1 AND id=$2",
			[event.tenantId, requestId]
		);
		const token = credentialVaultFromEnvironment().decrypt(
			{ tenantId: event.tenantId, provider: 'email-consent', credentialId: requestId },
			result.rows[0].token_envelope
		);
		return { ...result.rows[0], token };
	});
	if (!request) return;
	const base = publicApplicationUrl();
	if (!base) throw new Error('PUBLIC_APP_URL is not configured as a valid safe application URL');
	const result = await send(
		event.tenantId,
		{
			to: request.email,
			name: request.name,
			subject: 'Confirm your email preferences',
			text: `Please confirm that you want to receive email updates. This request expires in 48 hours.\n\nConfirm: ${base}/email-consent/${encodeURIComponent(request.token)}\n\nIf you did not request this, ignore this message.`,
			idempotencyKey: `email-consent:${requestId}`
		},
		pool
	);
	await withTenant(event.tenantId, null, async (client) => {
		await client.query(
			"UPDATE email_consent_requests SET status=$3,token_envelope='' WHERE tenant_id=$1 AND id=$2 AND status IN ('pending','queued')",
			[event.tenantId, requestId, result.status === 'uncertain' ? 'uncertain' : 'sent']
		);
	});
}

export async function confirmEmailConsent(token: string) {
	if (token.length < 32 || token.length > 128) return { confirmed: false };
	const hash = createHash('sha256').update(token).digest('hex');
	const tenants = await getPool().query('SELECT id FROM tenants ORDER BY id');
	for (const tenant of tenants.rows) {
		const result = await withTenant(String(tenant.id), null, async (client) => {
			const request = await client.query(
				'SELECT id,contact_id,email,status,expires_at FROM email_consent_requests WHERE tenant_id=$1 AND token_hash=$2 FOR UPDATE',
				[tenant.id, hash]
			);
			if (!request.rowCount) return null;
			const row = request.rows[0];
			if (row.status === 'confirmed') return true;
			if (!['sent', 'uncertain'].includes(row.status) || new Date(row.expires_at) <= new Date())
				return false;
			const contact = await client.query(
				'SELECT email FROM contacts WHERE tenant_id=$1 AND id=$2 FOR UPDATE',
				[tenant.id, row.contact_id]
			);
			if (
				!contact.rowCount ||
				normalizeEmail(contact.rows[0].email ?? '') !== normalizeEmail(row.email)
			)
				return false;
			await client.query(
				'UPDATE contacts SET data=data || $3::jsonb,updated_at=now() WHERE tenant_id=$1 AND id=$2',
				[
					tenant.id,
					row.contact_id,
					JSON.stringify({
						consent: true,
						consentAt: new Date().toISOString(),
						consentSource: 'double_opt_in'
					})
				]
			);
			await client.query(
				"INSERT INTO consents(tenant_id,contact_id,channel,purpose,status,source,lawful_basis) VALUES($1,$2,'email','marketing','granted','double_opt_in','consent')",
				[tenant.id, row.contact_id]
			);
			await client.query(
				"DELETE FROM email_suppressions WHERE tenant_id=$1 AND email=$2 AND reason='unsubscribe'",
				[tenant.id, normalizeEmail(row.email)]
			);
			await client.query(
				"UPDATE email_consent_requests SET status=CASE WHEN id=$3 THEN 'confirmed' ELSE 'cancelled' END,confirmed_at=CASE WHEN id=$3 THEN now() ELSE confirmed_at END,token_envelope='' WHERE tenant_id=$1 AND contact_id=$2 AND status IN ('pending','queued','sent','uncertain')",
				[tenant.id, row.contact_id, row.id]
			);
			return true;
		});
		if (result !== null) return { confirmed: result };
	}
	return { confirmed: false };
}

export async function getEmailPreferences(token: string) {
	if (token.length < 32 || token.length > 128) return null;
	const hash = createHash('sha256').update(token).digest('hex');
	const tenants = await getPool().query('SELECT id,slug FROM tenants ORDER BY id');
	for (const tenant of tenants.rows) {
		const result = await withTenant(String(tenant.id), null, async (client) =>
			client.query(
				'SELECT p.expires_at,c.data FROM email_preference_tokens p JOIN contacts c ON c.tenant_id=p.tenant_id AND c.id=p.contact_id WHERE p.tenant_id=$1 AND p.token_hash=$2 AND p.used_at IS NULL',
				[tenant.id, hash]
			)
		);
		if (result.rowCount) {
			const row = result.rows[0];
			if (new Date(row.expires_at) <= new Date()) return null;
			return { tenantSlug: tenant.slug, marketingEnabled: row.data?.consent === true };
		}
	}
	return null;
}

export async function updateEmailPreferences(token: string, enabled: boolean) {
	const hash = createHash('sha256').update(token).digest('hex');
	const tenants = await getPool().query('SELECT id,slug FROM tenants ORDER BY id');
	for (const tenant of tenants.rows) {
		const updated = await withTenant(String(tenant.id), null, async (client) => {
			const found = await client.query(
				'SELECT p.id,p.contact_id,c.email,c.data FROM email_preference_tokens p JOIN contacts c ON c.tenant_id=p.tenant_id AND c.id=p.contact_id WHERE p.tenant_id=$1 AND p.token_hash=$2 AND p.expires_at>now() AND p.used_at IS NULL FOR UPDATE OF p,c',
				[tenant.id, hash]
			);
			if (!found.rowCount) return null;
			const row = found.rows[0];
			await client.query(
				'UPDATE email_preference_tokens SET used_at=now() WHERE tenant_id=$1 AND id=$2',
				[tenant.id, row.id]
			);
			if (enabled)
				return {
					tenantSlug: tenant.slug,
					email: row.email,
					contactId: row.contact_id,
					confirmationRequired: true
				};
			await client.query(
				'UPDATE contacts SET data=data || \'{"consent":false}\'::jsonb,updated_at=now() WHERE tenant_id=$1 AND id=$2',
				[tenant.id, row.contact_id]
			);
			await client.query(
				"INSERT INTO consents(tenant_id,contact_id,channel,purpose,status,source,lawful_basis) VALUES($1,$2,'email','marketing','withdrawn','preference_center','consent')",
				[tenant.id, row.contact_id]
			);
			if (row.email) {
				const email = normalizeEmail(row.email);
				await client.query(
					"INSERT INTO email_suppressions(tenant_id,email,reason,source) VALUES($1,$2,'unsubscribe','preference_center') ON CONFLICT(tenant_id,email) DO UPDATE SET reason=CASE WHEN email_suppressions.reason IN ('bounce','complaint') THEN email_suppressions.reason ELSE 'unsubscribe' END,source='preference_center',created_at=now()",
					[tenant.id, email]
				);
				const cancelled = await client.query(
					"UPDATE email_messages SET status='suppressed',suppression_reason='preference_withdrawn',updated_at=now() WHERE tenant_id=$1 AND contact_id=$2 AND status IN ('queued','scheduled') RETURNING batch_id",
					[tenant.id, row.contact_id]
				);
				for (const batchId of new Set(cancelled.rows.map((message) => String(message.batch_id))))
					await refreshBatch(client, String(tenant.id), batchId);
			}
			return { tenantSlug: tenant.slug, confirmationRequired: false };
		});
		if (updated) return updated;
	}
	return null;
}

export async function dispatchScheduledEmailBatches(pool: Pool, tenantId: string) {
	return withTenant(
		tenantId,
		null,
		async (client) => {
			const due = await client.query(
				`SELECT id,email_id,segment_id,scheduled_at,scheduled_timezone,schedule_hash FROM email_send_batches WHERE tenant_id=$1 AND status='scheduled' AND scheduled_at<=now() ORDER BY scheduled_at LIMIT 20 FOR UPDATE SKIP LOCKED`,
				[tenantId]
			);
			let dispatched = 0;
			for (const batch of due.rows) {
				const messages = await client.query(
					`SELECT id,contact_id,to_address,to_name,from_address,subject,body,html_body,idempotency_key,status FROM email_messages WHERE tenant_id=$1 AND batch_id=$2 ORDER BY contact_id`,
					[tenantId, batch.id]
				);
				const recipients = messages.rows
					.map(
						(message) =>
							[String(message.contact_id), String(message.to_address), String(message.to_name)] as [
								string,
								string,
								string
							]
					)
					.sort((a, b) => String(a[0]).localeCompare(String(b[0])));
				const currentHash = scheduledEmailSnapshotHash({
					emailId: batch.email_id,
					segmentId: batch.segment_id,
					scheduledAt: new Date(batch.scheduled_at).toISOString(),
					fromAddress: messages.rows[0]?.from_address ?? '',
					subject: messages.rows[0]?.subject ?? '',
					body: messages.rows[0]?.body ?? '',
					html: messages.rows[0]?.html_body ?? '',
					recipients
				});
				if (!messages.rowCount || currentHash !== batch.schedule_hash) {
					await client.query(
						"UPDATE email_send_batches SET status='failed' WHERE tenant_id=$1 AND id=$2",
						[tenantId, batch.id]
					);
					await client.query(
						"UPDATE email_messages SET status='failed',last_error='Scheduled snapshot integrity check failed.',updated_at=now() WHERE tenant_id=$1 AND batch_id=$2 AND status='scheduled'",
						[tenantId, batch.id]
					);
					await client.query(
						"INSERT INTO audit_log(tenant_id,action,resource,record_id,details) VALUES($1,'email.schedule_integrity_failed','email_batches',$2,$3)",
						[tenantId, batch.id, { scheduleHash: batch.schedule_hash }]
					);
					continue;
				}
				const ready = messages.rows.filter((message) => message.status === 'scheduled');
				if (!ready.length) {
					await client.query(
						"UPDATE email_send_batches SET status='completed_with_issues' WHERE tenant_id=$1 AND id=$2",
						[tenantId, batch.id]
					);
					await client.query(
						'UPDATE workspace_records SET data=data || \'{"status":"completed_with_issues"}\'::jsonb,updated_at=now() WHERE tenant_id=$1 AND resource=\'emails\' AND id=$2',
						[tenantId, batch.email_id]
					);
					continue;
				}
				await client.query(
					"UPDATE email_send_batches SET status='queued' WHERE tenant_id=$1 AND id=$2",
					[tenantId, batch.id]
				);
				await client.query(
					'UPDATE workspace_records SET data=data || \'{"status":"queued"}\'::jsonb,updated_at=now() WHERE tenant_id=$1 AND resource=\'emails\' AND id=$2',
					[tenantId, batch.email_id]
				);
				await client.query(
					"UPDATE email_messages SET status='queued',updated_at=now() WHERE tenant_id=$1 AND batch_id=$2 AND status='scheduled'",
					[tenantId, batch.id]
				);
				for (const message of ready)
					await client.query(
						"INSERT INTO outbox_events(tenant_id,event_type,payload,idempotency_key) VALUES($1,'email.send',$2,$3) ON CONFLICT(idempotency_key) DO NOTHING",
						[tenantId, { messageId: message.id }, message.idempotency_key]
					);
				dispatched += ready.length;
			}
			return { dispatched };
		},
		pool
	);
}

export async function previewEmail(
	session: Session,
	emailId: string,
	options: {
		segmentId?: string | null;
		scheduledAt?: string | null;
		campaignId?: string | null;
		variantSubjects?: { A: string; B: string } | null;
	} = {}
) {
	if (session.demo)
		throw new CommunicationError(
			'Demo mode can preview synthetic drafts in the app but cannot contact real recipients.',
			403
		);
	const workspace = await tenantContext(session, true);
	const { subject, body, html } = getDraft(workspace, emailId);
	const variantSubjects = options.variantSubjects
		? { A: options.variantSubjects.A.trim(), B: options.variantSubjects.B.trim() }
		: null;
	if (Boolean(options.campaignId) !== Boolean(variantSubjects))
		throw new CommunicationError('Choose a campaign and provide both subject variants.', 422);
	if (
		variantSubjects &&
		(!options.campaignId ||
			!/^[0-9a-f-]{36}$/i.test(options.campaignId) ||
			!variantSubjects.A ||
			!variantSubjects.B ||
			variantSubjects.A.length > 998 ||
			variantSubjects.B.length > 998 ||
			variantSubjects.A === variantSubjects.B)
	)
		throw new CommunicationError(
			'Provide two distinct email subjects within the allowed length.',
			422
		);
	if (variantSubjects && options.scheduledAt)
		throw new CommunicationError(
			'Campaign subject tests require a fresh approval preview at send time.',
			422
		);
	const scheduledAt = options.scheduledAt ? new Date(options.scheduledAt) : null;
	if (
		scheduledAt &&
		(!Number.isFinite(scheduledAt.getTime()) ||
			scheduledAt.getTime() < Date.now() + 15 * 60_000 ||
			scheduledAt.getTime() > Date.now() + 90 * 24 * 60 * 60_000)
	)
		throw new CommunicationError(
			'Scheduled sends must be at least 15 minutes and no more than 90 days in the future.',
			422
		);
	const result = await withTenant(workspace.tenant.id, session.userId, async (client) => {
		const draft = await client.query(
			"SELECT data FROM workspace_records WHERE tenant_id=$1 AND resource='emails' AND id=$2",
			[workspace.tenant.id, emailId]
		);
		if (!draft.rowCount)
			throw new CommunicationError('Email draft not found in the active tenant.', 404);
		const content = draft.rows[0].data as Record<string, unknown>;
		if (options.campaignId) {
			const campaign = await client.query(
				"SELECT 1 FROM campaigns c JOIN tenants t ON t.id=c.tenant_id WHERE c.tenant_id=$1 AND c.id=$2 AND c.status IN ('published','active','scheduled') AND (c.starts_at IS NULL OR c.starts_at<=now()) AND (c.ends_at IS NULL OR c.ends_at>now()) AND t.suspended_at IS NULL",
				[workspace.tenant.id, options.campaignId]
			);
			if (!campaign.rowCount)
				throw new CommunicationError('This campaign is not available for email testing.', 404);
		}
		if (
			contentHash(subject, body, html) !==
			contentHash(
				String(content.subject ?? '').trim(),
				String(content.body ?? content.text ?? '').trim() ||
					plainTextFromEmailHtml(sanitizeEmailHtml(String(content.htmlBody ?? ''))),
				sanitizeEmailHtml(String(content.htmlBody ?? ''))
			)
		)
			throw new CommunicationError('The draft changed. Reload it before previewing.', 409);
		const targetedContactId = await workflowDraftContact(client, workspace.tenant.id, emailId);
		if (targetedContactId && options.segmentId)
			throw new CommunicationError(
				'Workflow drafts are restricted to their approved contact and cannot target a segment.',
				422
			);
		const recipients = await readEligible(
			client,
			workspace.tenant.id,
			options.segmentId,
			targetedContactId
		);
		const config = await getSesCredentials(workspace.tenant.id, client);
		return { recipients, config };
	});
	let quota;
	let recipients = result.recipients;
	let sandboxMode = false;
	let sandboxExcludedCount = 0;
	try {
		const provider = new SesEmailProvider({
			region: result.config.region,
			fromAddress: result.config.fromAddress,
			credentials: {
				accessKeyId: result.config.accessKeyId,
				secretAccessKey: result.config.secretAccessKey,
				...(result.config.sessionToken ? { sessionToken: result.config.sessionToken } : {})
			}
		});
		const [verified, status] = await Promise.all([
			provider.verifySenderIdentity(result.config.fromAddress),
			provider.getSendingQuota()
		]);
		if (!verified.verifiedForSending)
			throw new CommunicationError('SES sending identity is no longer verified.', 409);
		sandboxMode = !status.productionAccessEnabled;
		if (sandboxMode) {
			const approvedRecipients = await sesEligibleRecipients(
				provider,
				recipients,
				status.productionAccessEnabled
			);
			sandboxExcludedCount = recipients.length - approvedRecipients.length;
			recipients = approvedRecipients;
		}
		quota = {
			remaining24Hour: Math.max(0, status.max24HourSend - status.sentLast24Hours),
			maxSendRate: status.maxSendRate
		};
	} catch (error) {
		if (error instanceof CommunicationError) throw error;
		throw new CommunicationError(
			'SES verification or quota check failed; no messages were queued.',
			503
		);
	}
	const withinQuota = recipients.length <= quota.remaining24Hour && quota.maxSendRate > 0;
	const variantSeed = variantSubjects ? randomBytes(32).toString('hex') : null;
	const variantAssignments: Record<string, 'A' | 'B'> = variantSeed
		? assignCampaignEmailVariants(recipients, variantSeed)
		: {};
	const variantSnapshot =
		variantSubjects && variantSeed && options.campaignId
			? {
					campaignId: options.campaignId,
					subjects: variantSubjects,
					seed: variantSeed,
					assignments: variantAssignments
				}
			: null;
	const variantHash = variantSnapshot ? campaignVariantHash(variantSnapshot) : null;
	const unitCost = Number(process.env.EMAIL_ESTIMATED_COST_USD_PER_RECIPIENT);
	const estimatedCost =
		process.env.EMAIL_ESTIMATED_COST_USD_PER_RECIPIENT && Number.isFinite(unitCost) && unitCost >= 0
			? { currency: 'USD', perRecipientUsd: unitCost, totalUsd: recipients.length * unitCost }
			: null;
	let previewToken: string | null = null;
	let expiresAt: string | null = null;
	if (recipients.length && withinQuota) {
		previewToken = randomBytes(32).toString('base64url');
		expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
		await withTenant(workspace.tenant.id, session.userId, async (client) => {
			await client.query(
				'INSERT INTO email_send_previews(tenant_id,email_id,token_hash,content_hash,recipients,recipient_count,from_address,created_by,expires_at,segment_id,html_hash,scheduled_at,scheduled_timezone,sandbox_mode,campaign_id,campaign_variant_snapshot,campaign_variant_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)',
				[
					workspace.tenant.id,
					emailId,
					createHash('sha256').update(previewToken!).digest('hex'),
					contentHash(subject, body, html),
					recipients,
					recipients.length,
					result.config.fromAddress,
					session.userId,
					expiresAt,
					options.segmentId ?? null,
					createHash('sha256').update(html).digest('hex'),
					scheduledAt,
					scheduledAt ? workspace.tenant.timeZone : null,
					sandboxMode,
					options.campaignId ?? null,
					variantSnapshot,
					variantHash
				]
			);
			await client.query(
				'INSERT INTO audit_log(tenant_id,actor_id,action,resource,record_id,details) VALUES($1,$2,$3,$4,$5,$6)',
				[
					workspace.tenant.id,
					session.userId,
					'email.previewed',
					'emails',
					emailId,
					{
						count: recipients.length,
						contentHash: contentHash(subject, body, html),
						segmentId: options.segmentId ?? null,
						scheduledAt: scheduledAt?.toISOString() ?? null,
						campaignId: options.campaignId ?? null,
						variantCounts: variantSnapshot
							? {
									A: Object.values(variantAssignments).filter((v) => v === 'A').length,
									B: Object.values(variantAssignments).filter((v) => v === 'B').length
								}
							: null
					}
				]
			);
		});
	}
	return {
		previewToken,
		emailId,
		subject,
		from: result.config.fromAddress,
		count: recipients.length,
		recipients,
		quota,
		withinQuota,
		sandboxMode,
		sandboxExcludedCount,
		segmentId: options.segmentId ?? null,
		scheduledAt: scheduledAt?.toISOString() ?? null,
		timeZone: scheduledAt ? workspace.tenant.timeZone : null,
		estimatedCost,
		expiresAt,
		campaignId: options.campaignId ?? null,
		variantCounts: variantSnapshot
			? {
					A: Object.values(variantAssignments).filter((v) => v === 'A').length,
					B: Object.values(variantAssignments).filter((v) => v === 'B').length
				}
			: null,
		approvalRequired: Boolean(previewToken)
	};
}

export async function approveEmailSend(
	session: Session,
	input: { previewToken: string; approved: boolean }
) {
	if (!input.approved)
		throw new CommunicationError('Explicit approval is required before queueing email.', 422);
	if (session.demo) throw new CommunicationError('Demo mode cannot send email.', 403);
	const workspace = await tenantContext(session, true);
	const tokenHash = createHash('sha256').update(input.previewToken).digest('hex');
	return withTenant(workspace.tenant.id, session.userId, async (client) => {
		const preview = await client.query(
			'SELECT * FROM email_send_previews WHERE tenant_id=$1 AND token_hash=$2 FOR UPDATE',
			[workspace.tenant.id, tokenHash]
		);
		if (!preview.rowCount)
			throw new CommunicationError('Preview token is invalid or expired.', 404);
		const row = preview.rows[0] as {
			id: string;
			email_id: string;
			content_hash: string;
			recipients: Recipient[];
			recipient_count: number;
			from_address: string;
			segment_id: string | null;
			scheduled_at: Date | null;
			scheduled_timezone: string | null;
			html_hash: string;
			sandbox_mode: boolean;
			campaign_id: string | null;
			campaign_variant_snapshot: {
				campaignId: string;
				subjects: { A: string; B: string };
				seed: string;
				assignments: Record<string, 'A' | 'B'>;
			} | null;
			campaign_variant_hash: string | null;
			expires_at: Date;
			consumed_at: Date | null;
		};
		if (row.consumed_at)
			throw new CommunicationError('This approval preview has already been used.', 409);
		if (new Date(row.expires_at).getTime() <= Date.now())
			throw new CommunicationError('This approval preview expired. Review a fresh preview.', 409);
		const variantSnapshot = row.campaign_variant_snapshot;
		if (
			Boolean(row.campaign_id) !== Boolean(variantSnapshot) ||
			(variantSnapshot && variantSnapshot.campaignId !== row.campaign_id) ||
			(variantSnapshot && campaignVariantHash(variantSnapshot) !== row.campaign_variant_hash)
		)
			throw new CommunicationError('The campaign subject preview is invalid.', 409);
		const draft = await client.query(
			"SELECT data FROM workspace_records WHERE tenant_id=$1 AND resource='emails' AND id=$2",
			[workspace.tenant.id, row.email_id]
		);
		if (!draft.rowCount) throw new CommunicationError('Email draft no longer exists.', 404);
		const data = draft.rows[0].data as Record<string, unknown>;
		const subject = String(data.subject ?? '').trim();
		const html = sanitizeEmailHtml(String(data.htmlBody ?? ''));
		const body = String(data.body ?? data.text ?? '').trim() || plainTextFromEmailHtml(html);
		if (
			contentHash(subject, body, html) !== row.content_hash ||
			createHash('sha256').update(html).digest('hex') !== row.html_hash
		)
			throw new CommunicationError('The draft changed after preview. Review a fresh preview.', 409);
		const targetedContactId = await workflowDraftContact(client, workspace.tenant.id, row.email_id);
		if (targetedContactId && row.segment_id)
			throw new CommunicationError(
				'Workflow drafts are restricted to their approved contact and cannot target a segment.',
				409
			);
		let eligible = await readEligible(
			client,
			workspace.tenant.id,
			row.segment_id,
			targetedContactId
		);
		const sesConfig = await getSesCredentials(workspace.tenant.id, client);
		const sesProvider = new SesEmailProvider({
			region: sesConfig.region,
			fromAddress: sesConfig.fromAddress,
			credentials: {
				accessKeyId: sesConfig.accessKeyId,
				secretAccessKey: sesConfig.secretAccessKey,
				...(sesConfig.sessionToken ? { sessionToken: sesConfig.sessionToken } : {})
			}
		});
		const [senderVerified, currentQuota] = await Promise.all([
			sesProvider.verifySenderIdentity(sesConfig.fromAddress),
			sesProvider.getSendingQuota()
		]);
		if (
			!senderVerified.verifiedForSending ||
			sesConfig.fromAddress !== row.from_address ||
			currentQuota.maxSendRate <= 0 ||
			currentQuota.max24HourSend - currentQuota.sentLast24Hours < row.recipient_count ||
			row.sandbox_mode === currentQuota.productionAccessEnabled
		)
			throw new CommunicationError(
				'SES sender, account mode, or quota changed after preview. Review a fresh preview.',
				409
			);
		if (row.sandbox_mode) eligible = await sesEligibleRecipients(sesProvider, eligible, false);
		const expected = (row.recipients as Recipient[])
			.map((recipient) => `${recipient.id}:${recipient.email}:${recipient.name}`)
			.sort();
		const actual = eligible
			.map((recipient) => `${recipient.id}:${recipient.email}:${recipient.name}`)
			.sort();
		if (JSON.stringify(expected) !== JSON.stringify(actual))
			throw new CommunicationError(
				'Consent or suppression changed after preview. Review a fresh recipient list.',
				409
			);
		if (variantSnapshot) {
			const campaign = await client.query(
				"SELECT 1 FROM campaigns c JOIN tenants t ON t.id=c.tenant_id WHERE c.tenant_id=$1 AND c.id=$2 AND c.status IN ('published','active','scheduled') AND (c.starts_at IS NULL OR c.starts_at<=now()) AND (c.ends_at IS NULL OR c.ends_at>now()) AND t.suspended_at IS NULL",
				[workspace.tenant.id, row.campaign_id]
			);
			if (!campaign.rowCount)
				throw new CommunicationError(
					'This campaign is no longer available for email testing.',
					409
				);
			const recipientIds = new Set(
				(row.recipients as Recipient[]).map((recipient) => recipient.id)
			);
			if (
				recipientIds.size !== row.recipient_count ||
				Object.keys(variantSnapshot.assignments).length !== recipientIds.size ||
				[...recipientIds].some((id) => !['A', 'B'].includes(variantSnapshot.assignments[id]))
			)
				throw new CommunicationError('The frozen subject assignments are invalid.', 409);
		}
		const batchId = crypto.randomUUID();
		const scheduled = Boolean(row.scheduled_at);
		const scheduleHash = row.scheduled_at
			? scheduledEmailSnapshotHash({
					emailId: row.email_id,
					segmentId: row.segment_id,
					scheduledAt: new Date(row.scheduled_at).toISOString(),
					fromAddress: row.from_address,
					subject,
					body,
					html,
					recipients: (row.recipients as Recipient[]).map((recipient) => [
						recipient.id,
						recipient.email,
						recipient.name
					])
				})
			: '';
		await client.query(
			'INSERT INTO email_send_batches(id,tenant_id,email_id,preview_id,approved_by,status,recipient_count,scheduled_at,scheduled_timezone,schedule_hash,segment_id,campaign_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',
			[
				batchId,
				workspace.tenant.id,
				row.email_id,
				row.id,
				session.userId,
				scheduled ? 'scheduled' : 'queued',
				row.recipient_count,
				row.scheduled_at,
				row.scheduled_timezone,
				scheduled ? scheduleHash : null,
				row.segment_id,
				row.campaign_id
			]
		);
		for (const recipient of row.recipients as Recipient[]) {
			const messageId = crypto.randomUUID();
			const key = `email.send:${batchId}:${recipient.id}`;
			const variantKey = variantSnapshot?.assignments[recipient.id] ?? null;
			const recipientSubject = variantKey ? variantSnapshot!.subjects[variantKey] : subject;
			await client.query(
				`INSERT INTO email_messages(id,tenant_id,batch_id,email_id,contact_id,to_address,to_name,subject,body,from_address,idempotency_key,html_body,segment_id,status,campaign_id,campaign_variant)
				VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
				[
					messageId,
					workspace.tenant.id,
					batchId,
					row.email_id,
					recipient.id,
					recipient.email,
					recipient.name,
					recipientSubject,
					body,
					row.from_address,
					key,
					html,
					row.segment_id,
					scheduled ? 'scheduled' : 'queued',
					row.campaign_id,
					variantKey
				]
			);
			if (!scheduled)
				await client.query(
					"INSERT INTO outbox_events(tenant_id,event_type,payload,idempotency_key) VALUES($1,'email.send',$2,$3) ON CONFLICT(idempotency_key) DO NOTHING",
					[workspace.tenant.id, { messageId }, key]
				);
		}
		await client.query(
			'UPDATE email_send_previews SET consumed_at=now() WHERE tenant_id=$1 AND id=$2',
			[workspace.tenant.id, row.id]
		);
		await client.query(
			"UPDATE workspace_records SET data=data || $3::jsonb,updated_at=now() WHERE tenant_id=$1 AND resource='emails' AND id=$2",
			[
				workspace.tenant.id,
				row.email_id,
				JSON.stringify({ status: scheduled ? 'scheduled' : 'queued' })
			]
		);
		await client.query(
			'INSERT INTO audit_log(tenant_id,actor_id,action,resource,record_id,details) VALUES($1,$2,$3,$4,$5,$6)',
			[
				workspace.tenant.id,
				session.userId,
				'email.send_approved',
				'emails',
				row.email_id,
				{
					batchId,
					count: row.recipient_count,
					approved: true,
					scheduledAt: row.scheduled_at,
					segmentId: row.segment_id,
					scheduleHash: scheduled ? scheduleHash : null
				}
			]
		);
		return {
			ok: true,
			status: scheduled ? 'scheduled' : 'queued',
			batchId,
			queued: row.recipient_count,
			scheduledAt: row.scheduled_at ?? null,
			timeZone: row.scheduled_timezone ?? null
		};
	});
}

export async function sendEmailTest(
	session: Session,
	input: { emailId: string; approved: boolean }
) {
	if (!input.approved)
		throw new CommunicationError('Explicit test-send confirmation is required.', 422);
	if (session.demo) throw new CommunicationError('Demo mode cannot send email.', 403);
	const workspace = await tenantContext(session, true);
	const address = normalizeEmail(workspace.user.email);
	if (!emailPattern.test(address))
		throw new CommunicationError(
			'Your signed-in account needs a valid email address for a test send.',
			422
		);
	const { subject, body, html } = getDraft(workspace, input.emailId);
	const token = `email-test:${input.emailId}:${session.userId}:${contentHash(subject, body, html)}:${Math.floor(Date.now() / 900000)}`;
	const name = String(workspace.user.name || 'Email reviewer');
	const text = `${interpolate(body, { id: session.userId, name, email: address })}\n\nThis is a test message sent only to your signed-in account.`;
	const safeHtml = interpolateHtml(html, { id: session.userId, name, email: address });
	return sendTransactionalEmail(workspace.tenant.id, {
		to: address,
		name,
		subject: `[Test] ${subject}`,
		text,
		html: safeHtml,
		idempotencyKey: token
	});
}

function unsubscribeToken(tenantId: string, messageId: string, expires: number) {
	const secret = emailSigningSecret();
	if (!secret) throw new Error('EMAIL_SIGNING_SECRET is not configured');
	const payload = Buffer.from(JSON.stringify({ tenantId, messageId, expires })).toString(
		'base64url'
	);
	const signature = createHmac('sha256', secret).update(payload).digest('base64url');
	return `${payload}.${signature}`;
}

export function verifyUnsubscribeToken(token: string, now = Date.now()) {
	const secret = emailSigningSecret();
	const [payload, signature, extra] = token.split('.');
	if (!secret || !payload || !signature || extra) return null;
	const expected = createHmac('sha256', secret).update(payload).digest();
	let actual: Buffer;
	try {
		actual = Buffer.from(signature, 'base64url');
	} catch {
		return null;
	}
	if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
	try {
		const value = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
			tenantId?: unknown;
			messageId?: unknown;
			expires?: unknown;
		};
		if (
			typeof value.tenantId !== 'string' ||
			!/^[0-9a-f-]{36}$/i.test(value.tenantId) ||
			typeof value.messageId !== 'string' ||
			!/^[0-9a-f-]{36}$/i.test(value.messageId) ||
			typeof value.expires !== 'number' ||
			value.expires * 1000 <= now
		)
			return null;
		return { tenantId: value.tenantId, messageId: value.messageId, expires: value.expires };
	} catch {
		return null;
	}
}

export async function recordUnsubscribe(token: string) {
	const value = verifyUnsubscribeToken(token);
	if (!value) throw new CommunicationError('This unsubscribe link is invalid or expired.', 400);
	return withTenant(value.tenantId, null, async (client) => {
		const stored = await client.query(
			`SELECT u.token_hash,u.expires_at,u.used_at,m.contact_id,m.to_address
			FROM email_unsubscribe_tokens u JOIN email_messages m ON m.tenant_id=u.tenant_id AND m.id=u.message_id
			WHERE u.tenant_id=$1 AND u.message_id=$2 FOR UPDATE OF u`,
			[value.tenantId, value.messageId]
		);
		if (
			!stored.rowCount ||
			stored.rows[0].token_hash.trim() !== createHash('sha256').update(token).digest('hex') ||
			new Date(stored.rows[0].expires_at).getTime() <= Date.now()
		)
			throw new CommunicationError('This unsubscribe link is invalid or expired.', 400);
		if (stored.rows[0].used_at) return { ok: true, alreadyUnsubscribed: true };
		const contactId = stored.rows[0].contact_id as string;
		const email = normalizeEmail(stored.rows[0].to_address as string);
		await client.query(
			"INSERT INTO email_suppressions(tenant_id,email,reason,source) VALUES($1,$2,'unsubscribe','recipient_link') ON CONFLICT(tenant_id,email) DO UPDATE SET reason=CASE WHEN email_suppressions.reason IN ('bounce','complaint') THEN email_suppressions.reason ELSE 'unsubscribe' END,source='recipient_link',created_at=now()",
			[value.tenantId, email]
		);
		await client.query(
			'UPDATE contacts SET data=data || \'{"consent":false}\'::jsonb,updated_at=now() WHERE tenant_id=$1 AND id=$2',
			[value.tenantId, contactId]
		);
		await client.query(
			"INSERT INTO consents(tenant_id,contact_id,channel,purpose,status,source,lawful_basis) VALUES($1,$2,'email','marketing','withdrawn','recipient_link','consent')",
			[value.tenantId, contactId]
		);
		const cancelled = await client.query(
			"UPDATE email_messages SET status='suppressed',suppression_reason='unsubscribe',updated_at=now() WHERE tenant_id=$1 AND contact_id=$2 AND status IN ('queued','sending','scheduled') RETURNING batch_id",
			[value.tenantId, contactId]
		);
		for (const batchId of new Set(cancelled.rows.map((row) => String(row.batch_id))))
			await refreshBatch(client, value.tenantId, batchId);
		await client.query(
			'UPDATE email_unsubscribe_tokens SET used_at=COALESCE(used_at,now()) WHERE tenant_id=$1 AND message_id=$2',
			[value.tenantId, value.messageId]
		);
		await client.query(
			'INSERT INTO audit_log(tenant_id,action,resource,record_id,details) VALUES($1,$2,$3,$4,$5)',
			[value.tenantId, 'email.unsubscribed', 'contacts', contactId, { source: 'recipient_link' }]
		);
		return { ok: true };
	});
}

type EmailJob = { tenantId: string; payload: unknown };
async function reserveSendSlot(tenantId: string, rate: number, pool: Pool) {
	return withTenant(
		tenantId,
		null,
		async (client) => {
			await client.query(
				'INSERT INTO email_tenant_rate_limits(tenant_id) VALUES($1) ON CONFLICT(tenant_id) DO NOTHING',
				[tenantId]
			);
			const result = await client.query(
				'SELECT next_send_at FROM email_tenant_rate_limits WHERE tenant_id=$1 FOR UPDATE',
				[tenantId]
			);
			const slot = Math.max(Date.now(), new Date(result.rows[0].next_send_at).getTime());
			const next = new Date(slot + Math.ceil(1000 / Math.max(rate, 0.01)));
			await client.query(
				'UPDATE email_tenant_rate_limits SET next_send_at=$2,updated_at=now() WHERE tenant_id=$1',
				[tenantId, next]
			);
			return slot;
		},
		pool
	);
}

async function recheckBeforeSend(tenantId: string, messageId: string, pool: Pool) {
	return withTenant(
		tenantId,
		null,
		async (client) => {
			const result = await client.query(
				`SELECT m.status,m.batch_id,m.to_address,m.segment_id,c.id AS contact_id,c.email,c.name,c.data,c.stage,c.tags,c.created_at,c.archived_at,
			(SELECT data FROM workspace_records s WHERE s.tenant_id=m.tenant_id AND s.resource='segments' AND s.id=m.segment_id) AS segment_data,
			exists(SELECT 1 FROM email_suppressions s WHERE s.tenant_id=m.tenant_id AND s.email=m.to_address) AS suppressed
			FROM email_messages m JOIN contacts c ON c.tenant_id=m.tenant_id AND c.id=m.contact_id
			WHERE m.tenant_id=$1 AND m.id=$2 FOR UPDATE OF m`,
				[tenantId, messageId]
			);
			if (!result.rowCount || result.rows[0].status !== 'sending') return false;
			const row = result.rows[0];
			const contactForSegment = {
				id: row.contact_id,
				name: row.name,
				email: row.email,
				data: row.data,
				stage: row.stage,
				tags: row.tags,
				createdAt: row.created_at
			};
			const segmentValid =
				!row.segment_id ||
				Boolean(row.segment_data && segmentMatches(contactForSegment, row.segment_data));
			if (
				row.suppressed ||
				row.archived_at ||
				row.data?.consent !== true ||
				normalizeEmail(row.email ?? '') !== normalizeEmail(row.to_address) ||
				!segmentValid
			) {
				await client.query(
					"UPDATE email_messages SET status='suppressed',suppression_reason='consent_or_contact_changed',updated_at=now() WHERE tenant_id=$1 AND id=$2",
					[tenantId, messageId]
				);
				await refreshBatch(client, tenantId, row.batch_id);
				return false;
			}
			return true;
		},
		pool
	);
}

async function refreshBatch(client: PoolClient, tenantId: string, batchId: string) {
	await client.query(
		`WITH updated AS (UPDATE email_send_batches b SET status=CASE
		WHEN b.status='scheduled' AND EXISTS(SELECT 1 FROM email_messages m WHERE m.tenant_id=b.tenant_id AND m.batch_id=b.id AND m.status='scheduled') THEN 'scheduled'
		WHEN EXISTS(SELECT 1 FROM email_messages m WHERE m.tenant_id=b.tenant_id AND m.batch_id=b.id AND m.status IN ('queued','sending')) THEN 'queued'
		WHEN EXISTS(SELECT 1 FROM email_messages m WHERE m.tenant_id=b.tenant_id AND m.batch_id=b.id AND m.status IN ('suppressed','bounced','complained','uncertain','failed')) THEN 'completed_with_issues'
		ELSE 'completed' END WHERE b.tenant_id=$1 AND b.id=$2 RETURNING email_id,status)
		UPDATE workspace_records w SET data=w.data || jsonb_build_object('status',updated.status),updated_at=now() FROM updated WHERE w.tenant_id=$1 AND w.resource='emails' AND w.id=updated.email_id`,
		[tenantId, batchId]
	);
}

export async function handleEmailOutboxEvent(event: EmailJob, pool: Pool) {
	const payload = event.payload as { messageId?: unknown };
	if (typeof payload.messageId !== 'string') throw new Error('Email outbox payload is invalid');
	const messageId = payload.messageId;
	const data = (await withTenant(
		event.tenantId,
		null,
		async (client) => {
			// The worker has verified the signed outbox context. Scope every query to that tenant.
			const result = await client.query(
				`SELECT m.*,c.data AS contact_data,c.email AS current_email,c.name AS current_name,c.stage AS current_stage,c.tags AS current_tags,c.archived_at,
			(SELECT data FROM workspace_records s WHERE s.tenant_id=m.tenant_id AND s.resource='segments' AND s.id=m.segment_id) AS segment_data,
			exists(SELECT 1 FROM email_suppressions s WHERE s.tenant_id=m.tenant_id AND s.email=m.to_address) AS is_suppressed
			FROM email_messages m JOIN contacts c ON c.tenant_id=m.tenant_id AND c.id=m.contact_id WHERE m.tenant_id=$1 AND m.id=$2 FOR UPDATE OF m`,
				[event.tenantId, messageId]
			);
			if (!result.rowCount) throw new Error('Email message is not available for this tenant');
			const row = result.rows[0] as Record<string, any>;
			if (row.status === 'sending') {
				await client.query(
					"UPDATE email_messages SET status='uncertain',last_error='Worker stopped during an in-flight provider request; automatic resend blocked.',updated_at=now() WHERE tenant_id=$1 AND id=$2",
					[event.tenantId, messageId]
				);
				return null;
			}
			if (row.status !== 'queued') return null;
			const segmentValid =
				!row.segment_id ||
				Boolean(
					row.segment_data &&
					segmentMatches(
						{
							id: row.contact_id,
							name: row.current_name,
							email: row.current_email,
							data: row.contact_data,
							stage: row.current_stage,
							tags: row.current_tags,
							createdAt: row.contact_data?.createdAt
						},
						row.segment_data
					)
				);
			const reason = row.is_suppressed
				? 'suppression_list'
				: row.archived_at ||
					  normalizeEmail(row.current_email ?? '') !== normalizeEmail(row.to_address)
					? 'contact_changed'
					: row.contact_data?.consent !== true
						? 'consent_revoked'
						: !segmentValid
							? 'segment_changed'
							: null;
			if (reason) {
				await client.query(
					"UPDATE email_messages SET status='suppressed',suppression_reason=$3,updated_at=now() WHERE tenant_id=$1 AND id=$2",
					[event.tenantId, messageId, reason]
				);
				await refreshBatch(client, event.tenantId, row.batch_id);
				return null;
			}
			const config = await getSesCredentials(event.tenantId, client);
			await client.query(
				"UPDATE email_messages SET status='sending',attempts=attempts+1,updated_at=now() WHERE tenant_id=$1 AND id=$2",
				[event.tenantId, messageId]
			);
			const expires = Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60;
			const unsubscribe = unsubscribeToken(event.tenantId, messageId, expires);
			await client.query(
				'INSERT INTO email_unsubscribe_tokens(tenant_id,message_id,token_hash,expires_at) VALUES($1,$2,$3,to_timestamp($4)) ON CONFLICT(tenant_id,message_id) DO NOTHING',
				[event.tenantId, messageId, createHash('sha256').update(unsubscribe).digest('hex'), expires]
			);
			const preference = randomBytes(32).toString('base64url');
			await client.query(
				'INSERT INTO email_preference_tokens(tenant_id,contact_id,token_hash,expires_at) VALUES($1,$2,$3,to_timestamp($4)) ON CONFLICT(tenant_id,token_hash) DO NOTHING',
				[
					event.tenantId,
					row.contact_id,
					createHash('sha256').update(preference).digest('hex'),
					expires
				]
			);
			return { ...row, config, unsubscribe, preference };
		},
		pool
	)) as (Record<string, any> & { config: Awaited<ReturnType<typeof getSesCredentials>> }) | null;
	if (!data) return;
	const baseUrl = publicApplicationUrl();
	if (!baseUrl) throw new Error('PUBLIC_APP_URL is not configured as a valid safe application URL');
	const unsubscribeUrl = `${baseUrl}/unsubscribe/${encodeURIComponent(data.unsubscribe)}`;
	const preferencesUrl = `${baseUrl}/email-preferences/${encodeURIComponent(data.preference)}`;
	const name = String(data.to_name || data.current_name || 'there');
	const variables = { id: data.contact_id, name, email: data.to_address };
	const messageBody = `${interpolate(String(data.body), variables)}\n\nManage email preferences: ${preferencesUrl}\nTo stop receiving these messages, unsubscribe: ${unsubscribeUrl}`;
	const messageHtml = `${interpolateHtml(String(data.html_body ?? ''), variables)}<hr><p><a href="${htmlEscape(preferencesUrl)}">Manage email preferences</a> · <a href="${htmlEscape(unsubscribeUrl)}">Unsubscribe</a></p>`;
	const provider = new SesEmailProvider({
		region: data.config.region,
		fromAddress: data.config.fromAddress,
		credentials: {
			accessKeyId: data.config.accessKeyId,
			secretAccessKey: data.config.secretAccessKey,
			...(data.config.sessionToken ? { sessionToken: data.config.sessionToken } : {})
		}
	});
	let providerCallStarted = false;
	try {
		const quota = await provider.getSendingQuota();
		const recipientVerified =
			quota.productionAccessEnabled || (await provider.verifyRecipientIdentity(data.to_address));
		if (!recipientVerified) {
			await withTenant(
				event.tenantId,
				null,
				async (client) => {
					await client.query(
						"UPDATE email_messages SET status='suppressed',suppression_reason='ses_sandbox_unverified',last_error='Recipient identity is not verified for SES sandbox.',updated_at=now() WHERE tenant_id=$1 AND id=$2 AND status='sending'",
						[event.tenantId, messageId]
					);
					await refreshBatch(client, event.tenantId, data.batch_id);
				},
				pool
			);
			return;
		}
		if (quota.maxSendRate <= 0 || quota.sentLast24Hours >= quota.max24HourSend)
			throw new Error('SES quota or sending access is unavailable');
		const sendAt = await reserveSendSlot(event.tenantId, quota.maxSendRate, pool);
		const delay = sendAt - Date.now();
		if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
		if (!(await recheckBeforeSend(event.tenantId, messageId, pool))) return;
		providerCallStarted = true;
		const result = await provider.send({
			tenantId: event.tenantId,
			to: data.to_address,
			from: data.from_address,
			subject: interpolate(data.subject, { id: data.contact_id, name, email: data.to_address }),
			text: messageBody,
			html: messageHtml,
			idempotencyKey: data.idempotency_key
		});
		await withTenant(
			event.tenantId,
			null,
			async (client) => {
				await client.query(
					"UPDATE email_messages SET status='accepted',provider_message_id=$3,updated_at=now() WHERE tenant_id=$1 AND id=$2 AND status='sending'",
					[event.tenantId, messageId, result.providerMessageId]
				);
				await refreshBatch(client, event.tenantId, data.batch_id);
			},
			pool
		);
	} catch (error) {
		const safe =
			error instanceof Error
				? error.message
						.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[redacted email]')
						.slice(0, 500)
				: 'SES send failed';
		await withTenant(
			event.tenantId,
			null,
			async (client) => {
				await client.query(
					"UPDATE email_messages SET status=$4,last_error=$3,updated_at=now() WHERE tenant_id=$1 AND id=$2 AND status='sending'",
					[event.tenantId, messageId, safe, providerCallStarted ? 'uncertain' : 'failed']
				);
				await refreshBatch(client, event.tenantId, data.batch_id);
			},
			pool
		);
		if (providerCallStarted)
			throw new Error(
				'SES send outcome is uncertain; automatic resend is blocked to avoid duplicate messages.'
			);
		throw new Error('SES send was not attempted; automatic retry is blocked for operator review.');
	}
}

export type TransactionalEmailInput = {
	to: string;
	name: string;
	subject: string;
	text: string;
	html?: string;
	idempotencyKey: string;
};
export type TransactionalEmailResult = {
	id: string;
	status: 'accepted' | 'already_accepted' | 'uncertain';
	providerMessageId?: string;
};

async function sendTransactionalEmailWithConfig(
	tenantId: string,
	input: TransactionalEmailInput,
	pool: Pool,
	configOverride?: {
		region: string;
		fromAddress: string;
		accessKeyId: string;
		secretAccessKey: string;
		sessionToken?: string;
	}
): Promise<TransactionalEmailResult> {
	const to = normalizeEmail(input.to);
	if (
		!emailPattern.test(to) ||
		input.to.length > 254 ||
		input.name.length > 180 ||
		!input.subject.trim() ||
		input.subject.length > 998 ||
		!input.text ||
		input.text.length > 20_000 ||
		(input.html?.length ?? 0) > 100_000 ||
		!/^[A-Za-z0-9._:-]{1,220}$/.test(input.idempotencyKey)
	)
		throw new CommunicationError('Transactional email input is invalid.', 422);
	const config =
		configOverride ??
		(await withTenant(tenantId, null, (client) => getSesCredentials(tenantId, client), pool));
	const provider = new SesEmailProvider({
		region: config.region,
		fromAddress: config.fromAddress,
		credentials: {
			accessKeyId: config.accessKeyId,
			secretAccessKey: config.secretAccessKey,
			...(config.sessionToken ? { sessionToken: config.sessionToken } : {})
		}
	});
	let quota: Awaited<ReturnType<typeof provider.getSendingQuota>>;
	try {
		const [verified, accountQuota] = await Promise.all([
			provider.verifySenderIdentity(config.fromAddress),
			provider.getSendingQuota()
		]);
		if (
			!verified.verifiedForSending ||
			accountQuota.maxSendRate <= 0 ||
			accountQuota.sentLast24Hours >= accountQuota.max24HourSend
		)
			throw new CommunicationError(
				'SES identity or account quota is not available for transactional mail.',
				503
			);
		if (!accountQuota.productionAccessEnabled && !(await provider.verifyRecipientIdentity(to)))
			throw new CommunicationError(
				'This recipient is not SES-verified for sandbox transactional email.',
				422
			);
		quota = accountQuota;
	} catch (error) {
		if (error instanceof CommunicationError) throw error;
		throw new CommunicationError('SES could not verify transactional mail readiness.', 503);
	}
	const id = crypto.randomUUID();
	let bodyEnvelope: string;
	try {
		bodyEnvelope = credentialVaultFromEnvironment().encrypt(
			{ tenantId, provider: 'ses-transactional-email', credentialId: input.idempotencyKey },
			JSON.stringify({ subject: input.subject, text: input.text, html: input.html ?? '' })
		);
	} catch {
		throw new CommunicationError('Transactional email encryption is not configured.', 503);
	}
	const reserved = await withTenant(
		tenantId,
		null,
		async (client) => {
			await client.query(
				`INSERT INTO transactional_email_messages(id,tenant_id,to_address,to_name,subject,body_envelope,from_address,idempotency_key,status)
			VALUES($1,$2,$3,$4,$5,$6,$7,$8,'queued') ON CONFLICT(tenant_id,idempotency_key) DO NOTHING`,
				[
					id,
					tenantId,
					to,
					input.name,
					input.subject,
					bodyEnvelope,
					config.fromAddress,
					input.idempotencyKey
				]
			);
			const result = await client.query(
				'SELECT id,status,provider_message_id,body_envelope,to_address,to_name,subject,from_address FROM transactional_email_messages WHERE tenant_id=$1 AND idempotency_key=$2 FOR UPDATE',
				[tenantId, input.idempotencyKey]
			);
			if (!result.rowCount)
				throw new CommunicationError('Transactional send ledger is unavailable.', 503);
			const row = result.rows[0];
			if (row.status === 'accepted')
				return {
					id: row.id as string,
					status: 'already_accepted' as const,
					...(row.provider_message_id
						? { providerMessageId: row.provider_message_id as string }
						: {})
				};
			if (row.status === 'sending') {
				await client.query(
					"UPDATE transactional_email_messages SET status='uncertain',last_error='Worker stopped during an in-flight provider request; automatic resend blocked.',updated_at=now() WHERE tenant_id=$1 AND id=$2",
					[tenantId, row.id]
				);
				return { id: row.id as string, status: 'uncertain' as const };
			}
			if (row.status !== 'queued') return { id: row.id as string, status: 'uncertain' as const };
			await client.query(
				"UPDATE transactional_email_messages SET status='sending',attempts=attempts+1,updated_at=now() WHERE tenant_id=$1 AND id=$2",
				[tenantId, row.id]
			);
			return {
				id: row.id as string,
				status: 'sending' as const,
				bodyEnvelope: row.body_envelope as string,
				to: row.to_address as string,
				name: row.to_name as string,
				subject: row.subject as string,
				from: row.from_address as string
			};
		},
		pool
	);
	if (reserved.status !== 'sending') return reserved;
	try {
		const sendAt = await reserveSendSlot(tenantId, quota.maxSendRate, pool);
		const delay = sendAt - Date.now();
		if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
		const message = JSON.parse(
			credentialVaultFromEnvironment().decrypt(
				{ tenantId, provider: 'ses-transactional-email', credentialId: input.idempotencyKey },
				reserved.bodyEnvelope
			)
		) as { subject: string; text: string; html?: string };
		const result = await provider.send({
			tenantId,
			to: reserved.to,
			from: reserved.from,
			subject: message.subject,
			text: message.text,
			...(message.html ? { html: message.html } : {}),
			idempotencyKey: input.idempotencyKey
		});
		await withTenant(
			tenantId,
			null,
			async (client) => {
				await client.query(
					"UPDATE transactional_email_messages SET status='accepted',provider_message_id=$3,updated_at=now() WHERE tenant_id=$1 AND id=$2 AND status='sending'",
					[tenantId, reserved.id, result.providerMessageId]
				);
				await client.query(
					'INSERT INTO audit_log(tenant_id,action,resource,record_id,details) VALUES($1,$2,$3,$4,$5)',
					[
						tenantId,
						'email.transactional.accepted',
						'transactional_email',
						reserved.id,
						{ provider: 'ses' }
					]
				);
			},
			pool
		);
		return { id: reserved.id, status: 'accepted', providerMessageId: result.providerMessageId };
	} catch (error) {
		const safe =
			error instanceof Error
				? error.message
						.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[redacted email]')
						.slice(0, 400)
				: 'SES send error';
		await withTenant(
			tenantId,
			null,
			async (client) => {
				await client.query(
					"UPDATE transactional_email_messages SET status='uncertain',last_error=$3,updated_at=now() WHERE tenant_id=$1 AND id=$2 AND status='sending'",
					[tenantId, reserved.id, safe]
				);
				await client.query(
					'INSERT INTO audit_log(tenant_id,action,resource,record_id,details) VALUES($1,$2,$3,$4,$5)',
					[
						tenantId,
						'email.transactional.uncertain',
						'transactional_email',
						reserved.id,
						{ provider: 'ses' }
					]
				);
			},
			pool
		);
		return { id: reserved.id, status: 'uncertain' };
	}
}

/** Worker-only sender configured by the tenant's encrypted SES connection. */
export function sendTransactionalEmail(
	tenantId: string,
	input: TransactionalEmailInput,
	pool: Pool = getPool()
): Promise<TransactionalEmailResult> {
	return sendTransactionalEmailWithConfig(tenantId, input, pool);
}

/** Worker-only SES sender for account security mail before a tenant config can be enabled. */
export function operatorTransactionalEmailConfigured() {
	const AWS_REGION = process.env.AWS_REGION || env.AWS_REGION;
	const AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID || env.AWS_ACCESS_KEY_ID;
	const AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY || env.AWS_SECRET_ACCESS_KEY;
	const SES_FROM_ADDRESS = process.env.SES_FROM_ADDRESS || env.SES_FROM_ADDRESS;
	const validUrl = Boolean(publicApplicationUrl());
	return (
		!!AWS_REGION && !!AWS_ACCESS_KEY_ID && !!AWS_SECRET_ACCESS_KEY && !!SES_FROM_ADDRESS && validUrl
	);
}

export function sendOperatorTransactionalEmail(
	tenantId: string,
	input: TransactionalEmailInput,
	pool: Pool = getPool()
): Promise<TransactionalEmailResult> {
	const {
		AWS_REGION,
		AWS_ACCESS_KEY_ID,
		AWS_SECRET_ACCESS_KEY,
		AWS_SESSION_TOKEN,
		SES_FROM_ADDRESS
	} = process.env;
	if (!AWS_REGION || !AWS_ACCESS_KEY_ID || !AWS_SECRET_ACCESS_KEY || !SES_FROM_ADDRESS)
		throw new CommunicationError('Operator SES configuration is unavailable.', 503);
	return sendTransactionalEmailWithConfig(tenantId, input, pool, {
		region: AWS_REGION,
		accessKeyId: AWS_ACCESS_KEY_ID,
		secretAccessKey: AWS_SECRET_ACCESS_KEY,
		...(AWS_SESSION_TOKEN ? { sessionToken: AWS_SESSION_TOKEN } : {}),
		fromAddress: SES_FROM_ADDRESS
	});
}

export async function applySesEvent(input: {
	messageId: string;
	providerMessageId: string;
	eventType: 'Delivery' | 'Bounce' | 'Complaint' | 'Open' | 'Click';
	recipients?: string[];
	eventPayload: Record<string, unknown>;
}) {
	const pool = getPool();
	const tenants = await pool.query('SELECT id FROM tenants ORDER BY id');
	let matched = false;
	for (const row of tenants.rows)
		await withTenant(row.id, null, async (client) => {
			const message = await client.query(
				'SELECT id,to_address,contact_id,batch_id FROM email_messages WHERE tenant_id=$1 AND provider_message_id=$2 FOR UPDATE',
				[row.id, input.providerMessageId]
			);
			if (message.rowCount) {
				matched = true;
				const inserted = await client.query(
					`INSERT INTO email_provider_events(tenant_id,sns_message_id,provider_message_id,event_type,event_payload) VALUES($1,$2,$3,$4,$5) ON CONFLICT(tenant_id,sns_message_id) DO NOTHING RETURNING id`,
					[row.id, input.messageId, input.providerMessageId, input.eventType, input.eventPayload]
				);
				if (!inserted.rowCount) return;
				const status =
					input.eventType === 'Delivery'
						? 'delivered'
						: input.eventType === 'Bounce'
							? 'bounced'
							: input.eventType === 'Complaint'
								? 'complained'
								: null;
				if (status)
					await client.query(
						'UPDATE email_messages SET status=$3,updated_at=now() WHERE tenant_id=$1 AND id=$2',
						[row.id, message.rows[0].id, status]
					);
				if (input.eventType === 'Open')
					await client.query(
						'UPDATE email_send_batches SET opened_count=opened_count+1 WHERE tenant_id=$1 AND id=$2',
						[row.id, message.rows[0].batch_id]
					);
				if (input.eventType === 'Click')
					await client.query(
						'UPDATE email_send_batches SET clicked_count=clicked_count+1 WHERE tenant_id=$1 AND id=$2',
						[row.id, message.rows[0].batch_id]
					);
				if (input.eventType === 'Bounce' || input.eventType === 'Complaint') {
					const email = normalizeEmail(message.rows[0].to_address);
					await client.query(
						"INSERT INTO email_suppressions(tenant_id,email,reason,source) VALUES($1,$2,$3,'ses_event') ON CONFLICT(tenant_id,email) DO UPDATE SET reason=EXCLUDED.reason,source='ses_event',created_at=now()",
						[row.id, email, input.eventType === 'Bounce' ? 'bounce' : 'complaint']
					);
					await client.query(
						'UPDATE contacts SET data=data || \'{"consent":false}\'::jsonb,updated_at=now() WHERE tenant_id=$1 AND id=$2',
						[row.id, message.rows[0].contact_id]
					);
					await client.query(
						"INSERT INTO consents(tenant_id,contact_id,channel,purpose,status,source,lawful_basis) VALUES($1,$2,'email','marketing','withdrawn','ses_event','consent')",
						[row.id, message.rows[0].contact_id]
					);
				}
				await client.query(
					'INSERT INTO audit_log(tenant_id,action,resource,record_id,details) VALUES($1,$2,$3,$4,$5)',
					[
						row.id,
						`email.${input.eventType.toLowerCase()}`,
						'emails',
						message.rows[0].id,
						{ eventId: input.messageId }
					]
				);
				await refreshBatch(client, row.id, message.rows[0].batch_id);
				return;
			}
			const transactional = await client.query(
				'SELECT id FROM transactional_email_messages WHERE tenant_id=$1 AND provider_message_id=$2 FOR UPDATE',
				[row.id, input.providerMessageId]
			);
			if (!transactional.rowCount) return;
			matched = true;
			if (input.eventType === 'Open' || input.eventType === 'Click') return;
			const inserted = await client.query(
				'INSERT INTO transactional_email_events(tenant_id,sns_message_id,provider_message_id,event_type) VALUES($1,$2,$3,$4) ON CONFLICT(tenant_id,sns_message_id) DO NOTHING RETURNING id',
				[row.id, input.messageId, input.providerMessageId, input.eventType]
			);
			if (inserted.rowCount)
				await client.query(
					'UPDATE transactional_email_messages SET status=$3,updated_at=now() WHERE tenant_id=$1 AND id=$2',
					[
						row.id,
						transactional.rows[0].id,
						input.eventType === 'Delivery'
							? 'accepted'
							: input.eventType === 'Bounce'
								? 'bounced'
								: 'complained'
					]
				);
		});
	return { accepted: true, matched };
}

export function verifyWebhookMessage(message: Record<string, unknown>, certificatePem: string) {
	return verifySnsSignature(message, certificatePem);
}
