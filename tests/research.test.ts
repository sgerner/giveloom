import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import {
	parse990PF,
	relationshipPaths,
	scoreProspect,
	unpack990PFArchive
} from '../src/lib/server/research';
import {
	canViewGraphEvidence,
	validateGraphEvidence,
	validateIntroductionTransition
} from '../src/lib/server/intelligence';
const sample =
	'<Return><ReturnHeader><TaxYr>2024</TaxYr><Filer><BusinessName><BusinessNameLine1Txt>Sample Test Foundation</BusinessNameLine1Txt></BusinessName></Filer></ReturnHeader><ReturnData><IRS990PF><OfficerDirTrstKeyEmplInfoGrp><PersonNm>Alex Example</PersonNm><TitleTxt>Trustee</TitleTxt></OfficerDirTrstKeyEmplInfoGrp><GrantOrContributionPdDurYrGrp><RecipientBusinessName><BusinessNameLine1Txt>Example Community</BusinessNameLine1Txt></RecipientBusinessName><GrantOrContributionPurposeTxt>Education</GrantOrContributionPurposeTxt></GrantOrContributionPdDurYrGrp></IRS990PF></ReturnData></Return>';
const source = 'https://apps.irs.gov/pub/epostcard/990/xml/example.xml';
function zipFile(name: string, contents: string) {
	const data = Buffer.from(contents),
		compressed = deflateRawSync(data);
	let crc = 0xffffffff;
	for (const byte of data) {
		crc ^= byte;
		for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
	}
	crc = (crc ^ 0xffffffff) >>> 0;
	const file = Buffer.from(name),
		local = Buffer.alloc(30);
	local.writeUInt32LE(0x04034b50, 0);
	local.writeUInt16LE(20, 4);
	local.writeUInt16LE(8, 8);
	local.writeUInt32LE(crc, 14);
	local.writeUInt32LE(compressed.length, 18);
	local.writeUInt32LE(data.length, 22);
	local.writeUInt16LE(file.length, 26);
	const central = Buffer.alloc(46);
	central.writeUInt32LE(0x02014b50, 0);
	central.writeUInt16LE(20, 4);
	central.writeUInt16LE(20, 6);
	central.writeUInt16LE(8, 10);
	central.writeUInt32LE(crc, 16);
	central.writeUInt32LE(compressed.length, 20);
	central.writeUInt32LE(data.length, 24);
	central.writeUInt16LE(file.length, 28);
	const centralOffset = local.length + file.length + compressed.length,
		eocd = Buffer.alloc(22);
	eocd.writeUInt32LE(0x06054b50, 0);
	eocd.writeUInt16LE(1, 8);
	eocd.writeUInt16LE(1, 10);
	eocd.writeUInt32LE(central.length + file.length, 12);
	eocd.writeUInt32LE(centralOffset, 16);
	return Buffer.concat([local, file, compressed, central, file, eocd]);
}
describe('Evidence-based research', () => {
	it('preserves filing provenance and never calls trustees donors', () => {
		const records = parse990PF(sample, source);
		expect(records).toHaveLength(3);
		expect(records[1].reason).toContain('does not imply a personal donation');
		expect(
			records.every((r) => r.outreachAllowed === false && r.evidence[0].sourceUrl === source)
		).toBe(true);
	});
	it('parses the public 2015 IRS 990-PF fixture and preserves filing versions', () => {
		const xml = readFileSync(
			resolve('tests/fixtures/irs-990pf-johnson-patient-assistance.xml'),
			'utf8'
		);
		const records = parse990PF(xml, 'https://apps.irs.gov/pub/epostcard/990/xml/fixture.xml');
		expect(
			records.some((record) => record.name.includes('JOHNSON &amp; JOHNSON PATIENT ASSISTANCE'))
		).toBe(true);
		expect(records.filter((record) => record.recordType === 'person').length).toBeGreaterThan(5);
		expect(records.some((record) => record.recordType === 'organization')).toBe(true);
		expect(
			records.every(
				(record) => record.filingKey && record.sourceVersion && record.outreachAllowed === false
			)
		).toBe(true);
	});
	it('safely unpacks only bounded top-level XML ZIP entries and verifies CRCs', () => {
		const valid = zipFile('return.xml', sample);
		expect(unpack990PFArchive(valid)).toEqual([{ name: 'return.xml', xml: sample }]);
		expect(() => unpack990PFArchive(zipFile('../return.xml', sample))).toThrow(/safe filenames/);
		const corrupt = Buffer.from(valid);
		corrupt[35] ^= 1;
		expect(() => unpack990PFArchive(corrupt)).toThrow();
	});
	it('blocks XXE and non-IRS source URLs', () => {
		expect(() => parse990PF('<!DOCTYPE test>' + sample, source)).toThrow(/entities/);
		expect(() => parse990PF(sample, 'http://127.0.0.1/private')).toThrow(/IRS/);
	});
	it('rejects public charity documents rather than inventing donor lists', () => {
		expect(() => parse990PF('<Return><ReturnData><IRS990/></ReturnData></Return>', source)).toThrow(
			/990-PF/
		);
	});
	it('missing attributes reduce confidence rather than acting as known zero evidence', () => {
		expect(scoreProspect({ affinity: 1 })).toMatchObject({ score: 100, confidence: 0.35 });
		expect(scoreProspect({})).toMatchObject({ score: null, confidence: 0 });
	});
	it('finds evidence-backed two hop paths without loops', () => {
		const edges = [
			{ fromId: 'a', toId: 'b', kind: 'board', evidence: 'filing' },
			{ fromId: 'b', toId: 'c', kind: 'board', evidence: 'filing' },
			{ fromId: 'c', toId: 'a', kind: 'friend', evidence: '' }
		];
		expect(relationshipPaths(edges, 'a', 'c', 1)).toHaveLength(0);
		expect(relationshipPaths(edges, 'a', 'c', 2)[0]).toHaveLength(2);
	});
	it('requires explicit evidence for personal relationships', () => {
		expect(() =>
			validateGraphEvidence({
				kind: 'known_by',
				evidence: 'Board overlap',
				evidenceType: 'public_filing'
			})
		).toThrow(/explicit confirmation/);
		expect(
			validateGraphEvidence({
				kind: 'known_by',
				evidence: 'Donor confirmed in call note',
				evidenceType: 'donor_confirmed'
			})
		).toBe(true);
		expect(() =>
			validateGraphEvidence({
				kind: 'family_relationship',
				evidence: 'Staff note',
				evidenceType: 'tenant_note'
			})
		).toThrow(/explicit confirmation/);
	});
	it('limits relationship evidence by its privacy scope and membership role', () => {
		expect(canViewGraphEvidence('volunteer', 'public_source')).toBe(true);
		expect(canViewGraphEvidence('volunteer', 'tenant')).toBe(false);
		expect(canViewGraphEvidence('fundraiser', 'tenant')).toBe(true);
		expect(canViewGraphEvidence('fundraiser', 'restricted')).toBe(false);
		expect(canViewGraphEvidence('admin', 'restricted')).toBe(true);
	});
	it('requires donor yes with a recorded source before consented stage', () => {
		expect(() => validateIntroductionTransition('donor_asked', 'donor_consented')).toThrow(
			/authenticated donor portal/
		);
		expect(() => validateIntroductionTransition('proposed', 'draft_prepared')).toThrow(
			/one reviewed step/
		);
		expect(validateIntroductionTransition('donor_consented', 'draft_prepared').to).toBe(
			'draft_prepared'
		);
	});
});
