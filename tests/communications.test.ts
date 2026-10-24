import { describe, expect, it } from 'vitest';
import {
	eligibleEmailRecipients,
	assignCampaignEmailVariants,
	normalizeEmail,
	restrictEmailRecipientsToContact,
	verifySnsSignature,
	verifyUnsubscribeToken
} from '../src/lib/server/communications';

describe('email consent and suppression contracts', () => {
	it('requires explicit consent, valid address, and absence from normalized suppression list', () => {
		const records = [
			{ id: '1', name: 'Ada', email: 'ADA@example.org ', data: { consent: true } },
			{ id: '2', name: 'Ben', email: 'ben@example.org', data: { consent: false } },
			{ id: '3', name: 'Cal', email: 'cal@example.org', data: {} },
			{ id: '4', name: 'Dee', email: 'dee@example.org', data: { consent: true } },
			{ id: '5', name: 'Eli', email: 'not-an-address', data: { consent: true } }
		];
		expect(normalizeEmail(' ADA@EXAMPLE.org ')).toBe('ada@example.org');
		expect(eligibleEmailRecipients(records, ['DEE@EXAMPLE.ORG'])).toEqual([
			{ id: '1', name: 'Ada', email: 'ada@example.org' }
		]);
		const eligible = eligibleEmailRecipients(records, ['DEE@EXAMPLE.ORG']);
		expect(restrictEmailRecipientsToContact(eligible, '1')).toEqual([
			{ id: '1', name: 'Ada', email: 'ada@example.org' }
		]);
		expect(restrictEmailRecipientsToContact(eligible, '2')).toEqual([]);
		expect(restrictEmailRecipientsToContact(eligible, null)).toEqual(eligible);
	});

	it('assigns every campaign email recipient exactly once with a frozen deterministic cohort', () => {
		const recipients = [
			{ id: 'contact-a', email: 'a@example.org' },
			{ id: 'contact-b', email: 'b@example.org' },
			{ id: 'contact-c', email: 'c@example.org' }
		];
		const first = assignCampaignEmailVariants(recipients, 'fixed-test-seed');
		expect(assignCampaignEmailVariants(recipients, 'fixed-test-seed')).toEqual(first);
		expect(Object.keys(first).sort()).toEqual(recipients.map((recipient) => recipient.id).sort());
		expect(Object.values(first).every((variant) => variant === 'A' || variant === 'B')).toBe(true);
		expect(() =>
			assignCampaignEmailVariants(
				[...recipients, { id: 'contact-d', email: ' A@example.org ' }],
				'fixed-test-seed'
			)
		).toThrow(/assigned once/);
	});

	it('rejects unsigned or unsupported SES SNS notifications and malformed unsubscribe tokens', () => {
		expect(
			verifySnsSignature(
				{
					Type: 'Notification',
					Signature: 'fake',
					SignatureVersion: '2',
					SigningCertURL:
						'https://sns.us-east-1.amazonaws.com/SimpleNotificationService-example.pem'
				},
				'invalid cert'
			)
		).toBe(false);
		expect(
			verifySnsSignature(
				{
					Type: 'SubscriptionConfirmation',
					Signature: 'fake',
					SignatureVersion: '2',
					SigningCertURL:
						'https://sns.us-east-1.amazonaws.com/SimpleNotificationService-example.pem',
					Message: 'x'
				},
				'invalid cert'
			)
		).toBe(false);
		expect(verifyUnsubscribeToken('forged.payload')).toBeNull();
	});
});

describe('email studio contracts', () => {
	it('sanitizes authored email markup and derives a readable text fallback', async () => {
		const { sanitizeEmailHtml, plainTextFromEmailHtml, contentHash, segmentMatches } =
			await import('../src/lib/server/communications');
		const safe = sanitizeEmailHtml(
			'<h1 onclick="steal()">Hello</h1><script>alert(1)</script><a href="javascript:alert(1)">unsafe</a><p style="color:#123;background-image:url(x)">Updates</p>'
		);
		expect(safe).toContain('<h1>Hello</h1>');
		expect(safe).not.toContain('script');
		expect(safe).not.toContain('onclick');
		expect(safe).not.toContain('javascript:');
		expect(safe).not.toContain('background-image');
		expect(plainTextFromEmailHtml(safe)).toContain('Hello');
		expect(contentHash('Subject', 'Fallback', '<p>One</p>')).not.toBe(
			contentHash('Subject', 'Fallback', '<p>Two</p>')
		);
		expect(
			segmentMatches({ stage: 'active', data: { consent: true }, tags: ['major'] }, [
				{ field: 'stage', operator: 'equals', value: 'active' },
				{ field: 'consent', operator: 'equals', value: true },
				{ field: 'tags', operator: 'contains', value: 'major' }
			])
		).toBe(true);
	});

	it('freezes scheduled sends to an integrity hash covering content and exact recipients', async () => {
		const { scheduledEmailSnapshotHash } = await import('../src/lib/server/communications');
		const original = {
			emailId: 'email-1',
			segmentId: 'segment-1',
			scheduledAt: '2026-10-24T12:00:00.000Z',
			fromAddress: 'appeals@example.org',
			subject: 'Update',
			body: 'Plain',
			html: '<p>HTML</p>',
			recipients: [['contact-1', 'one@example.org', 'One Donor']] as Array<[string, string, string]>
		};
		const hash = scheduledEmailSnapshotHash(original);
		expect(scheduledEmailSnapshotHash({ ...original, html: '<p>Changed</p>' })).not.toBe(hash);
		expect(
			scheduledEmailSnapshotHash({
				...original,
				recipients: [['contact-2', 'two@example.org', 'Two Donor']]
			})
		).not.toBe(hash);
	});
});
