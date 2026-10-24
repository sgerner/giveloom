import { afterAll, describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { createOwnerAccount, getPool, mutatePostgres } from '../src/lib/server/database';
import {
	confirmEmailConsent,
	dispatchScheduledEmailBatches,
	handleEmailConsentOutboxEvent,
	listEmailDrafts,
	requestEmailConsent,
	saveEmailTemplate,
	scheduledEmailSnapshotHash,
	type TransactionalEmailInput,
	type TransactionalEmailResult
} from '../src/lib/server/communications';
const enabled =
	Boolean(process.env.DATABASE_URL) && process.env.RUN_POSTGRES_MUTATION_TESTS === 'true';
const withTenant = async <T>(
	tenantId: string,
	fn: (client: import('pg').PoolClient) => Promise<T>
) => {
	const client = await getPool().connect();
	try {
		await client.query('BEGIN');
		await client.query("SELECT set_config('app.tenant_id',$1,true)", [tenantId]);
		const result = await fn(client);
		await client.query('COMMIT');
		return result;
	} catch (error) {
		await client.query('ROLLBACK');
		throw error;
	} finally {
		client.release();
	}
};
const owner = async (prefix: string) => {
	const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
	const slug = `${prefix}-${suffix}`;
	const account = await createOwnerAccount({
		email: `${slug}@example.test`,
		name: 'Email Owner',
		passwordHash: 'fixture',
		organizationName: 'Email Expansion Tests',
		slug,
		sessionExpiresAt: new Date(Date.now() + 3600000),
		testOnlyVerifiedFixture: true
	});
	return {
		session: { userId: account.userId, tenantSlug: slug, role: 'owner', demo: false },
		tenantId: account.tenantId,
		slug
	};
};
afterAll(async () => {
	if (enabled) await getPool().end();
});

describe('email expansion database workflows', () => {
	it.skipIf(!enabled)(
		'accepts tenant-owned email segment/template references and rejects cross-tenant references',
		async () => {
			const account = await owner('email-ref-owner');
			const other = await owner('email-ref-other');
			const segment = (await mutatePostgres(
				account.slug,
				account.session.userId,
				'segments',
				{ name: 'Email segment', rules: [] },
				'create'
			)) as any;
			const foreignSegment = (await mutatePostgres(
				other.slug,
				other.session.userId,
				'segments',
				{ name: 'Foreign email segment', rules: [] },
				'create'
			)) as any;
			const template = await saveEmailTemplate(account.session, {
				name: `Email template ${randomUUID()}`,
				subject: 'A useful update',
				htmlBody: '<p>Thank you.</p>'
			});
			const foreignTemplate = await saveEmailTemplate(other.session, {
				name: `Foreign email template ${randomUUID()}`,
				subject: 'A different update',
				htmlBody: '<p>Thank you.</p>'
			});
			const draft = (await mutatePostgres(
				account.slug,
				account.session.userId,
				'emails',
				{
					subject: 'Segmented message',
					body: 'Plain text',
					htmlBody: '<p>Plain text</p>',
					segmentId: segment.id,
					templateId: template.id
				},
				'create'
			)) as any;
			expect(draft).toMatchObject({ segmentId: segment.id, templateId: template.id });
			await mutatePostgres(
				account.slug,
				account.session.userId,
				'emails',
				{ id: draft.id, subject: 'Unsegmented message', segmentId: null, templateId: template.id },
				'update'
			);
			const cleared = await withTenant(account.tenantId, async (client) =>
				client.query(
					"SELECT data ? 'segmentId' AS has_segment_id,data->'segmentId' AS segment_id FROM workspace_records WHERE tenant_id=$1 AND resource='emails' AND id=$2",
					[account.tenantId, draft.id]
				)
			);
			expect(cleared.rows[0]).toEqual({ has_segment_id: true, segment_id: null });
			await expect(
				mutatePostgres(
					account.slug,
					account.session.userId,
					'emails',
					{ subject: 'Wrong segment', segmentId: foreignSegment.id },
					'create'
				)
			).rejects.toThrow(/segmentId.*active tenant/i);
			await expect(
				mutatePostgres(
					account.slug,
					account.session.userId,
					'emails',
					{ subject: 'Wrong template', templateId: foreignTemplate.id },
					'create'
				)
			).rejects.toThrow(/templateId.*active tenant/i);
		}
	);

	it.skipIf(!enabled)(
		'paginates email drafts without dropping rows between PostgreSQL microsecond timestamps',
		async () => {
			const account = await owner('email-pagination');
			const session = account.session;
			const drafts = (await Promise.all(
				['Newest', 'Next'].map((subject) =>
					mutatePostgres(
						account.slug,
						session.userId,
						'emails',
						{
							subject,
							body: subject,
							htmlBody: `<p>${subject}</p>`,
							status: 'draft'
						},
						'create'
					)
				)
			)) as any[];
			await withTenant(account.tenantId, async (client) => {
				await client.query(
					"UPDATE workspace_records SET updated_at=CASE WHEN id=$2::uuid THEN '2026-10-23T12:00:00.123456Z'::timestamptz ELSE '2026-10-23T12:00:00.123455Z'::timestamptz END WHERE tenant_id=$1 AND resource='emails' AND id=ANY($3::uuid[])",
					[account.tenantId, drafts[0].id, drafts.map((draft) => draft.id)]
				);
			});
			const first = await listEmailDrafts(session, { limit: 1 });
			expect(first.emails.map((row: any) => row.subject)).toEqual(['Newest']);
			expect(first.nextCursor).toBeTruthy();
			const second = await listEmailDrafts(session, { limit: 1, cursor: first.nextCursor });
			expect(second.emails.map((row: any) => row.subject)).toEqual(['Next']);
		}
	);

	it.skipIf(!enabled)(
		'sends a one-time double-opt-in request and confirms consent only through its token',
		async () => {
			process.env.CREDENTIAL_VAULT_KEY ||= randomBytes(32).toString('base64');
			process.env.CREDENTIAL_VAULT_KEY_ID ||= 'primary';
			process.env.PUBLIC_APP_URL = 'https://email-tests.example.test';
			const account = await owner('email-consent');
			const contact = (await mutatePostgres(
				account.slug,
				account.session.userId,
				'contacts',
				{ name: 'Consent Donor', email: `donor-${randomUUID().slice(0, 8)}@example.test` },
				'create'
			)) as any;
			await requestEmailConsent(account.slug, contact.email);
			const event = await withTenant(
				account.tenantId,
				async (client) =>
					(
						await client.query(
							"SELECT id,payload FROM outbox_events WHERE tenant_id=$1 AND event_type='email.consent_request' ORDER BY created_at DESC LIMIT 1",
							[account.tenantId]
						)
					).rows[0]
			);
			expect(event).toBeTruthy();
			let sentText = '';
			const send = async (
				_tenantId: string,
				input: TransactionalEmailInput
			): Promise<TransactionalEmailResult> => {
				sentText = input.text;
				return { id: 'transactional-1', status: 'accepted' };
			};
			await handleEmailConsentOutboxEvent(
				{ tenantId: account.tenantId, payload: event.payload },
				getPool(),
				send as typeof import('../src/lib/server/communications').sendTransactionalEmail
			);
			const match = sentText.match(/\/email-consent\/([A-Za-z0-9_-]+)/);
			expect(match).toBeTruthy();
			const stored = await withTenant(
				account.tenantId,
				async (client) =>
					(
						await client.query(
							'SELECT status,token_envelope FROM email_consent_requests WHERE tenant_id=$1 AND id=$2',
							[account.tenantId, (event.payload as any).requestId]
						)
					).rows[0]
			);
			expect(stored).toMatchObject({ status: 'sent', token_envelope: '' });
			expect(await confirmEmailConsent(match![1]!)).toEqual({ confirmed: true });
			const rows = await withTenant(account.tenantId, async (client) => ({
				contact: (
					await client.query('SELECT data FROM contacts WHERE tenant_id=$1 AND id=$2', [
						account.tenantId,
						contact.id
					])
				).rows[0],
				consent: (
					await client.query(
						'SELECT status,source FROM consents WHERE tenant_id=$1 AND contact_id=$2 ORDER BY recorded_at DESC LIMIT 1',
						[account.tenantId, contact.id]
					)
				).rows[0]
			}));
			expect(rows.contact.data).toMatchObject({ consent: true, consentSource: 'double_opt_in' });
			expect(rows.consent).toMatchObject({ status: 'granted', source: 'double_opt_in' });
		}
	);

	it.skipIf(!enabled)(
		'stores sanitized reusable templates and dispatches only integrity-matching scheduled snapshots once',
		async () => {
			const account = await owner('email-schedule');
			const session = account.session;
			const saved = await saveEmailTemplate(session, {
				name: 'Thank you',
				subject: 'Thank you',
				htmlBody: '<p>Hello</p><script>bad()</script>'
			});
			expect(saved.htmlBody).toBe('<p>Hello</p>');
			const contact = (await mutatePostgres(
				account.slug,
				session.userId,
				'contacts',
				{ name: 'Schedule Donor', email: `scheduled-${randomUUID().slice(0, 8)}@example.test` },
				'create'
			)) as any;
			const email = (await mutatePostgres(
				account.slug,
				session.userId,
				'emails',
				{ subject: 'A scheduled update', body: 'Plain', htmlBody: '<p>Safe</p>', status: 'draft' },
				'create'
			)) as any;
			const previewId = randomUUID(),
				batchId = randomUUID(),
				messageId = randomUUID(),
				scheduledAt = new Date(Date.now() - 60_000).toISOString(),
				recipient = [[contact.id, contact.email, contact.name]] as Array<[string, string, string]>;
			const hash = scheduledEmailSnapshotHash({
				emailId: email.id,
				segmentId: null,
				scheduledAt,
				fromAddress: 'sender@example.test',
				subject: 'A scheduled update',
				body: 'Plain',
				html: '<p>Safe</p>',
				recipients: recipient
			});
			await withTenant(account.tenantId, async (client) => {
				await client.query(
					"INSERT INTO email_send_previews(id,tenant_id,email_id,token_hash,content_hash,recipients,recipient_count,from_address,created_by,expires_at,html_hash,scheduled_at,scheduled_timezone,sandbox_mode) VALUES($1,$2,$3,$4,$5,$6,1,$7,$8,now()+interval '1 hour',$9,$10,'America/Phoenix',false)",
					[
						previewId,
						account.tenantId,
						email.id,
						randomUUID().replaceAll('-', '').padEnd(64, 'a').slice(0, 64),
						'a'.repeat(64),
						JSON.stringify([{ id: contact.id, name: contact.name, email: contact.email }]),
						'sender@example.test',
						session.userId,
						'b'.repeat(64),
						scheduledAt
					]
				);
				await client.query(
					"INSERT INTO email_send_batches(id,tenant_id,email_id,preview_id,approved_by,status,recipient_count,scheduled_at,scheduled_timezone,schedule_hash,segment_id) VALUES($1,$2,$3,$4,$5,'scheduled',1,$6,'America/Phoenix',$7,NULL)",
					[batchId, account.tenantId, email.id, previewId, session.userId, scheduledAt, hash]
				);
				await client.query(
					"INSERT INTO email_messages(id,tenant_id,batch_id,email_id,contact_id,to_address,to_name,subject,body,from_address,idempotency_key,html_body,status) VALUES($1,$2,$3,$4,$5,$6,$7,'A scheduled update','Plain','sender@example.test',$8,'<p>Safe</p>','scheduled')",
					[
						messageId,
						account.tenantId,
						batchId,
						email.id,
						contact.id,
						contact.email,
						contact.name,
						`email.send:${batchId}:${contact.id}`
					]
				);
			});
			expect(await dispatchScheduledEmailBatches(getPool(), account.tenantId)).toEqual({
				dispatched: 1
			});
			expect(await dispatchScheduledEmailBatches(getPool(), account.tenantId)).toEqual({
				dispatched: 0
			});
			const outcome = await withTenant(account.tenantId, async (client) => ({
				batch: (
					await client.query('SELECT status FROM email_send_batches WHERE tenant_id=$1 AND id=$2', [
						account.tenantId,
						batchId
					])
				).rows[0],
				message: (
					await client.query('SELECT status FROM email_messages WHERE tenant_id=$1 AND id=$2', [
						account.tenantId,
						messageId
					])
				).rows[0],
				events: await client.query(
					"SELECT count(*)::int AS count FROM outbox_events WHERE tenant_id=$1 AND event_type='email.send' AND payload->>'messageId'=$2",
					[account.tenantId, messageId]
				)
			}));
			expect(outcome.batch.status).toBe('queued');
			expect(outcome.message.status).toBe('queued');
			expect(outcome.events.rows[0].count).toBe(1);
		}
	);
});
