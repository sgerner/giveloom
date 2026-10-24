import { describe, expect, it } from 'vitest';
import { analyzeContactCsv, contactsToCsv } from '../src/lib/server/csv';
import { validateResource } from '../src/lib/server/domain';

describe('contact CSV workflows', () => {
	it('reports in-file and existing-email duplicates for human review', () => {
		const preview = analyzeContactCsv(
			'name,email\nAda,ada@example.org\nAda Copy,ADA@example.org\nAlready,known@example.org\n',
			['known@example.org']
		);
		expect(preview.createCount).toBe(1);
		expect(preview.duplicateCount).toBe(2);
		expect(preview.rows[1]).toMatchObject({ status: 'duplicate', row: 3 });
	});

	it('accepts a UTF-8 BOM in exported or spreadsheet-produced CSV headers', () => {
		expect(analyzeContactCsv('\uFEFFname,email\nAda,ada@example.org\n', []).createCount).toBe(1);
	});

	it('includes invalid rows in the preview without silently importing them', () => {
		const preview = analyzeContactCsv(
			'name,email\n,missing-name@example.org\nValid,not-an-email\n',
			[]
		);
		expect(preview.invalidCount).toBe(2);
		expect(preview.createCount).toBe(0);
	});

	it('neutralizes spreadsheet formulas and quotes CSV values', () => {
		const csv = contactsToCsv([
			{ name: '=HYPERLINK("https://example.org")', email: 'ada@example.org', tags: ['safe,tag'] }
		]);
		expect(csv).toContain(`'=HYPERLINK(""https://example.org"")`);
		expect(csv).toContain('"safe,tag"');
	});

	it('rejects tenant and actor ownership fields even inside passthrough data', () => {
		expect(() => validateResource('contacts', { name: 'Ada', tenantId: 'other-tenant' })).toThrow(
			/managed by the server/i
		);
		expect(() =>
			validateResource('contacts', { name: 'Ada', custom: { tenant_id: 'other-tenant' } })
		).toThrow(/managed by the server/i);
		expect(() =>
			validateResource('contacts', { name: 'Ada', anotherContactId: 'foreign-record' })
		).toThrow(/managed by the server/i);
	});
});
