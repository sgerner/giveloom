import Papa from 'papaparse';
import { contactImportRowSchema } from './domain';

export type ContactImportPreview = {
	totalRows: number;
	createCount: number;
	duplicateCount: number;
	invalidCount: number;
	rows: Array<{
		row: number;
		status: 'ready' | 'duplicate' | 'invalid';
		reason?: string;
		contact?: Record<string, unknown>;
	}>;
};

export function analyzeContactCsv(
	csv: string,
	existingEmails: Iterable<string>,
	existingPhones: Iterable<string> = []
): ContactImportPreview {
	if (csv.length > 1_000_000) throw new Error('CSV is too large. Maximum size is 1 MB.');
	const parsed = Papa.parse<Record<string, string>>(csv, {
		header: true,
		skipEmptyLines: 'greedy',
		transformHeader: (value) =>
			value
				.replace(/^\uFEFF/, '')
				.trim()
				.toLowerCase()
	});
	if (parsed.errors.length) throw new Error(`CSV could not be parsed: ${parsed.errors[0].message}`);
	if (!parsed.meta.fields?.length || !parsed.meta.fields.includes('name'))
		throw new Error('CSV must include a name column.');
	if (parsed.data.length > 5000)
		throw new Error('CSV is too large. Maximum 5,000 contact rows per batch.');
	const seen = new Set(
		Array.from(existingEmails, (email) => email.trim().toLowerCase()).filter(Boolean)
	);
	const phoneKey = (value: string) => value.replace(/[^0-9+]/g, '');
	const phones = new Set(Array.from(existingPhones, phoneKey).filter(Boolean));
	const rows: ContactImportPreview['rows'] = [];
	parsed.data.forEach((source, index) => {
		const row = index + 2;
		const value = contactImportRowSchema.safeParse({
			name: source.name,
			email: source.email,
			phone: source.phone,
			stage: source.stage,
			tags: source.tags
		});
		if (!value.success) {
			rows.push({
				row,
				status: 'invalid',
				reason: value.error.issues[0]?.message || 'Invalid row.'
			});
			return;
		}
		const normalizedPhone = value.data.phone ? phoneKey(value.data.phone) : '';
		if (value.data.phone && !/^\+?[0-9]{7,15}$/.test(normalizedPhone)) {
			rows.push({
				row,
				status: 'invalid',
				reason: 'Phone must contain 7–15 digits with an optional country-code prefix.'
			});
			return;
		}
		if (normalizedPhone && phones.has(normalizedPhone)) {
			rows.push({
				row,
				status: 'duplicate',
				reason: 'Normalized phone already exists in this tenant or an earlier row; review manually.'
			});
			return;
		}
		const normalizedEmail = value.data.email?.toLowerCase();
		if (normalizedEmail && seen.has(normalizedEmail)) {
			rows.push({
				row,
				status: 'duplicate',
				reason: 'Email already exists in this tenant or an earlier row; review manually.'
			});
			return;
		}
		if (normalizedEmail) seen.add(normalizedEmail);
		if (normalizedPhone) phones.add(normalizedPhone);
		rows.push({
			row,
			status: 'ready',
			contact: {
				name: value.data.name,
				email: normalizedEmail || '',
				phone: value.data.phone || '',
				stage: value.data.stage || 'new',
				tags: value.data.tags
					? value.data.tags
							.split(',')
							.map((tag) => tag.trim())
							.filter(Boolean)
					: [],
				source: 'CSV import'
			}
		});
	});
	return {
		totalRows: parsed.data.length,
		createCount: rows.filter((item) => item.status === 'ready').length,
		duplicateCount: rows.filter((item) => item.status === 'duplicate').length,
		invalidCount: rows.filter((item) => item.status === 'invalid').length,
		rows
	};
}

const dangerous = /^[\u0000-\u0020]*[=+@-]/;
export function csvCell(value: unknown) {
	let text = value == null ? '' : typeof value === 'string' ? value : String(value);
	if (dangerous.test(text)) text = `'${text}`;
	return `"${text.replaceAll('"', '""')}"`;
}
export function contactsToCsv(contacts: Record<string, unknown>[]) {
	const columns = ['name', 'email', 'phone', 'stage', 'tags', 'source', 'createdAt'];
	return (
		[
			columns.map(csvCell).join(','),
			...contacts.map((contact) =>
				columns
					.map((key) =>
						csvCell(
							Array.isArray(contact[key]) ? (contact[key] as unknown[]).join('; ') : contact[key]
						)
					)
					.join(',')
			)
		].join('\r\n') + '\r\n'
	);
}
