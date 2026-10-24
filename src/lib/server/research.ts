import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
export { scoreProspect } from '../intelligence-scoring';
export type ResearchCandidate = {
	name: string;
	stage: string;
	recordType: string;
	reason: string;
	sourceFingerprint: string;
	evidence: { sourceName: string; sourceUrl: string; observedAt: string; confidence: string }[];
	filingYear: string;
	filingKey: string;
	sourceVersion: string;
	filingStatus: 'original' | 'amended' | 'corrected' | 'unknown';
	versionReceivedAt: string;
	sourceId?: string;
	matchStatus: 'possible';
	outreachAllowed: false;
};
function array<T>(value: T | T[] | undefined): T[] {
	return value === undefined ? [] : Array.isArray(value) ? value : [value];
}
function text(value: unknown): string {
	return typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
}
export function unpack990PFArchive(archive: Buffer): { name: string; xml: string }[] {
	if (archive.byteLength > 5 * 1024 * 1024) throw new Error('IRS ZIP must be smaller than 5 MiB.');
	const entries: {
		name: string;
		xml: string;
		crc: number;
		compressedSize: number;
		uncompressedSize: number;
		localOffset: number;
		method: number;
		flags: number;
	}[] = [];
	let offset = 0,
		expandedBytes = 0;
	while (offset + 4 <= archive.length && archive.readUInt32LE(offset) === 0x04034b50) {
		if (offset + 30 > archive.length) throw new Error('ZIP local header is truncated.');
		const flags = archive.readUInt16LE(offset + 6),
			method = archive.readUInt16LE(offset + 8),
			crc = archive.readUInt32LE(offset + 14);
		const compressedSize = archive.readUInt32LE(offset + 18),
			uncompressedSize = archive.readUInt32LE(offset + 22);
		const nameLength = archive.readUInt16LE(offset + 26),
			extraLength = archive.readUInt16LE(offset + 28);
		if (flags & 0x0009)
			throw new Error('Encrypted ZIP files and data descriptors are not accepted.');
		if (method !== 0 && method !== 8)
			throw new Error('ZIP entries must use stored or deflate compression.');
		const nameStart = offset + 30,
			dataStart = nameStart + nameLength + extraLength,
			dataEnd = dataStart + compressedSize;
		if (dataEnd > archive.length || dataStart < nameStart)
			throw new Error('ZIP entry exceeds the archive bounds.');
		const name = archive.toString('utf8', nameStart, nameStart + nameLength);
		if (!/^[A-Za-z0-9_.-]{1,160}\.xml$/i.test(name) || name.includes('..'))
			throw new Error('ZIP may contain only top-level XML filings with safe filenames.');
		if (uncompressedSize > 2 * 1024 * 1024 || expandedBytes + uncompressedSize > 10 * 1024 * 1024)
			throw new Error('Expanded IRS filings exceed the 10 MiB safety limit.');
		const compressed = archive.subarray(dataStart, dataEnd);
		const content =
			method === 0
				? Buffer.from(compressed)
				: inflateRawSync(compressed, { maxOutputLength: Math.max(1, uncompressedSize) });
		if (content.length !== uncompressedSize || crc32(content) !== crc)
			throw new Error('ZIP entry integrity check failed.');
		entries.push({
			name,
			xml: content.toString('utf8'),
			crc,
			compressedSize,
			uncompressedSize,
			localOffset: offset,
			method,
			flags
		});
		if (entries.length > 25)
			throw new Error('ZIP may contain no more than 25 IRS filings per import.');
		expandedBytes += content.length;
		offset = dataEnd;
	}
	let end = -1;
	for (let i = archive.length - 22; i >= Math.max(0, archive.length - 65557); i--) {
		if (archive.readUInt32LE(i) === 0x06054b50) {
			end = i;
			break;
		}
	}
	if (!entries.length || end < 0 || offset + 4 > end || archive.readUInt32LE(offset) !== 0x02014b50)
		throw new Error('ZIP must contain a complete central directory and at least one XML filing.');
	const disk = archive.readUInt16LE(end + 4),
		centralDisk = archive.readUInt16LE(end + 6),
		diskEntries = archive.readUInt16LE(end + 8),
		totalEntries = archive.readUInt16LE(end + 10),
		centralSize = archive.readUInt32LE(end + 12),
		centralOffset = archive.readUInt32LE(end + 16),
		commentLength = archive.readUInt16LE(end + 20);
	if (
		disk ||
		centralDisk ||
		diskEntries !== entries.length ||
		totalEntries !== entries.length ||
		centralOffset + centralSize !== end ||
		end + 22 + commentLength !== archive.length
	)
		throw new Error('ZIP central-directory metadata does not match its entries.');
	let cursor = centralOffset;
	for (const entry of entries) {
		if (cursor + 46 > end || archive.readUInt32LE(cursor) !== 0x02014b50)
			throw new Error('ZIP central-directory entry is invalid.');
		const flags = archive.readUInt16LE(cursor + 8),
			method = archive.readUInt16LE(cursor + 10),
			crc = archive.readUInt32LE(cursor + 16),
			compressedSize = archive.readUInt32LE(cursor + 20),
			uncompressedSize = archive.readUInt32LE(cursor + 24),
			nameLength = archive.readUInt16LE(cursor + 28),
			extraLength = archive.readUInt16LE(cursor + 30),
			entryComment = archive.readUInt16LE(cursor + 32),
			localOffset = archive.readUInt32LE(cursor + 42),
			name = archive.toString('utf8', cursor + 46, cursor + 46 + nameLength);
		if (
			name !== entry.name ||
			flags !== entry.flags ||
			method !== entry.method ||
			crc !== entry.crc ||
			compressedSize !== entry.compressedSize ||
			uncompressedSize !== entry.uncompressedSize ||
			localOffset !== entry.localOffset
		)
			throw new Error('ZIP central-directory data does not match its local file header.');
		cursor += 46 + nameLength + extraLength + entryComment;
	}
	if (cursor !== end) throw new Error('ZIP contains unexpected directory entries or metadata.');
	return entries.map(({ name, xml }) => ({ name, xml }));
}
function crc32(value: Buffer) {
	let crc = 0xffffffff;
	for (const byte of value) {
		crc ^= byte;
		for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
	}
	return (crc ^ 0xffffffff) >>> 0;
}
/** Uploaded XML only: this parser performs no outbound requests and cannot be an SSRF proxy. */
export function parse990PF(xml: string, sourceUrl: string): ResearchCandidate[] {
	if (Buffer.byteLength(xml) > 5 * 1024 * 1024) throw new Error('XML must be smaller than 5 MiB.');
	const url = new URL(sourceUrl);
	if (
		url.protocol !== 'https:' ||
		!['www.irs.gov', 'apps.irs.gov', 'irs.gov'].includes(url.hostname) ||
		url.username ||
		url.password
	)
		throw new Error('Provide the original HTTPS IRS source URL.');
	if (/<!DOCTYPE|<!ENTITY/i.test(xml))
		throw new Error('XML document types and entities are not allowed.');
	if (XMLValidator.validate(xml) !== true) throw new Error('The uploaded XML is not well formed.');
	const parsed = new XMLParser({
		ignoreAttributes: true,
		removeNSPrefix: true,
		parseTagValue: false,
		processEntities: false
	}).parse(xml);
	const root = parsed.Return;
	const pf = root?.ReturnData?.IRS990PF;
	if (!pf)
		throw new Error(
			'This importer accepts IRS 990-PF returns only. Public charity donor lists are not inferred.'
		);
	const header = root.ReturnHeader || {};
	const year = text(header.TaxYr) || text(header.TaxPeriodEndDt).slice(0, 4) || 'unknown';
	const filer = header.Filer || {};
	const orgName =
		[text(filer.BusinessName?.BusinessNameLine1Txt), text(filer.BusinessName?.BusinessNameLine2Txt)]
			.filter(Boolean)
			.join(' ') ||
		text(filer.BusinessName?.BusinessNameLine1) ||
		'Unnamed private foundation';
	const taxPeriodEnd = text(header.TaxPeriodEndDt) || (/^\d{4}$/.test(year) ? year + '-12-31' : '');
	const filingKey = createHash('sha256')
		.update([text(filer.EIN), taxPeriodEnd, text(header.ReturnTypeCd) || '990PF'].join('|'))
		.digest('hex');
	const amendedFlag = [root.AmendedReturnInd, header.AmendedReturnInd, pf.AmendedReturnInd].some(
		(value) => /true|1|yes/i.test(text(value))
	);
	const correctedFlag = [
		root.CorrectedReturnInd,
		header.CorrectedReturnInd,
		pf.CorrectedReturnInd
	].some((value) => /true|1|yes/i.test(text(value)));
	const status: ResearchCandidate['filingStatus'] = correctedFlag
		? 'corrected'
		: amendedFlag
			? 'amended'
			: 'unknown';
	const versionReceivedAt = text(header.ReturnTs) || new Date().toISOString();
	const observedAt = taxPeriodEnd || new Date().toISOString().slice(0, 10);
	const candidates: ResearchCandidate[] = [];
	const add = (name: string, type: string, claim: string, path: string) => {
		if (!name) return;
		candidates.push({
			name,
			stage: 'discovered',
			recordType: type,
			reason: claim,
			sourceFingerprint: createHash('sha256')
				.update(sourceUrl + '|' + year + '|' + path + '|' + name)
				.digest('hex'),
			filingYear: year,
			filingKey,
			sourceVersion: createHash('sha256').update(xml).digest('hex'),
			filingStatus: status,
			versionReceivedAt,
			matchStatus: 'possible',
			outreachAllowed: false,
			evidence: [
				{
					sourceName: 'IRS 990-PF ' + year + ' · ' + orgName + ' · ' + path,
					sourceUrl,
					observedAt,
					confidence: 'possible'
				}
			]
		});
	};
	add(
		orgName,
		'foundation',
		'Filing organization. A filing does not establish contact permission.',
		'ReturnHeader/Filer'
	);
	const officerInfo = pf.OfficerDirTrstKeyEmplInfoGrp;
	const trustees = array<any>(
		officerInfo?.OfficerDirTrstKeyEmplGrp ||
			officerInfo ||
			pf.OfficerDirectorTrusteeEmplGrp ||
			pf.OfficerDirectorTrusteeInfoGrp
	);
	for (const person of trustees) {
		const name =
			text(person.PersonNm) ||
			text(person.PersonName) ||
			text(person.BusinessName?.BusinessNameLine1Txt);
		const title = text(person.TitleTxt) || text(person.Title) || 'Officer/trustee';
		add(
			name,
			'person',
			title +
				' reported by ' +
				orgName +
				' in ' +
				year +
				'. This affiliation does not imply a personal donation.',
			'OfficerDirTrstKeyEmplInfoGrp'
		);
	}
	const grants = array<any>(
		pf.GrantOrContributionPdDurYrGrp ||
			pf.SupplementaryInformationGrp?.GrantOrContributionPdDurYrGrp ||
			pf.GrantsAndContriPaidDuringYrGrp
	);
	for (const grant of grants) {
		const name =
			text(grant.RecipientBusinessName?.BusinessNameLine1Txt) ||
			text(grant.RecipientBusinessName?.BusinessNameLine1) ||
			text(grant.RecipientPersonNm) ||
			text(grant.RecipientPersonName);
		const purpose =
			text(grant.GrantOrContributionPurposeTxt) || text(grant.GrantOrContributionPurpose);
		add(
			name,
			'organization',
			'Grant recipient reported by ' +
				orgName +
				' in ' +
				year +
				(purpose ? ': ' + purpose : '.') +
				' Not an individual donor claim.',
			'GrantOrContributionPdDurYrGrp'
		);
	}
	return [...new Map(candidates.map((c) => [c.sourceFingerprint, c])).values()];
}
export function relationshipPaths(
	edges: { fromId: string; toId: string; kind: string; evidence: string; confidence?: string }[],
	fromId: string,
	toId: string,
	maxDepth = 2
) {
	const queue = [{ node: fromId, path: [] as typeof edges }];
	const results: (typeof edges)[] = [];
	while (queue.length && results.length < 20) {
		const current = queue.shift()!;
		if (current.path.length >= Math.min(3, Math.max(1, maxDepth))) continue;
		for (const edge of edges.filter(
			(e) => (e.fromId === current.node || e.toId === current.node) && e.evidence
		)) {
			const next = edge.fromId === current.node ? edge.toId : edge.fromId;
			if (next === fromId || current.path.some((e) => e.fromId === next || e.toId === next))
				continue;
			const path = [...current.path, edge];
			if (next === toId) results.push(path);
			else queue.push({ node: next, path });
		}
	}
	return results;
}
