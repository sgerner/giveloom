import { afterAll, describe, expect, it } from 'vitest';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { demoWorkspaces } from '../src/lib/server/demo-data';
import {
	assertRoleCanMutate,
	redactWorkspaceRecord,
	safeMinorUnits,
	validateResource
} from '../src/lib/server/domain';

const testFile = join(tmpdir(), `giveloom-test-${process.pid}.json`);
process.env.DEMO_DATA_PATH = testFile;
const legacy = structuredClone(demoWorkspaces) as Record<string, Record<string, unknown>>;
for (const slug of Object.keys(legacy))
	for (const key of ['user', 'memberships', 'organizations', 'households', 'segments', 'events'])
		delete legacy[slug][key];
await writeFile(testFile, JSON.stringify({ tenants: legacy, audit: [], outbox: [] }), {
	mode: 0o600
});
const store = await import('../src/lib/server/store');
afterAll(async () => {
	await rm(testFile, { force: true });
});

describe('workspace domain contract', () => {
	it('keeps tenants isolated while allowing synthetic overlapping identity data', async () => {
		const riverstone = await store.getWorkspace('riverstone');
		const harbor = await store.getWorkspace('harbor');
		expect(riverstone?.contacts[0].email).toBe(harbor?.contacts[0].email);
		expect(riverstone?.tenant.id).not.toBe(harbor?.tenant.id);
		expect(riverstone?.contacts[0].id).not.toBe(harbor?.contacts[0].id);
		expect(riverstone?.tenant.demo).toBe(true);
	});

	it('validates integer minor units and rejects fractional gift amounts', () => {
		expect(() => validateResource('gifts', { amountMinor: 1250, currency: 'USD' })).not.toThrow();
		expect(() => validateResource('gifts', { amountMinor: 12.5, currency: 'USD' })).toThrow();
		expect(() =>
			validateResource('gifts', { amountMinor: Number.MAX_SAFE_INTEGER + 1, currency: 'USD' })
		).toThrow();
		expect(safeMinorUnits('9007199254740991')).toBe(Number.MAX_SAFE_INTEGER);
		expect(() => safeMinorUnits('9007199254740992')).toThrow(/integer range/i);
	});

	it('redacts nested donor PII and confidential notes before workspace responses', () => {
		const safe = redactWorkspaceRecord('volunteer', 'tasks', {
			title: 'Follow up',
			contactId: 'contact-id',
			contactEmail: 'private@example.test',
			profile: {
				email: 'private@example.test',
				address: '123 Main',
				sensitiveNotes: 'internal',
				note: 'private'
			},
			priority: 'normal'
		});
		expect(safe).toEqual({
			title: 'Follow up',
			contactId: 'contact-id',
			profile: {},
			priority: 'normal'
		});
		const gift = redactWorkspaceRecord('volunteer', 'gifts', {
			id: 'gift-id',
			contactId: 'contact-id',
			amountMinor: 2500,
			data: { donorEmail: 'private@example.test', donorName: 'Private Donor' }
		});
		expect(gift).toEqual({ id: 'gift-id', amountMinor: 2500, data: {} });
	});

	it('upgrades older demo files by adding only missing workspace collections', async () => {
		const riverstone = await store.getWorkspace('riverstone');
		expect(riverstone?.user.name).toBe('Jamie Rivera');
		expect(riverstone?.memberships).toHaveLength(2);
		expect(riverstone?.events).toHaveLength(1);
		const persisted = JSON.parse(await readFile(testFile, 'utf8'));
		expect(persisted.tenants.riverstone.contacts).toHaveLength(20);
	});

	it('requires finance permission for immutable gift event creation', () => {
		expect(() => assertRoleCanMutate('fundraiser', 'gifts', 'create')).toThrow(/finance manager/i);
		expect(() => assertRoleCanMutate('finance_manager', 'gifts', 'create')).not.toThrow();
	});

	it('does not permit email drafts to claim they were sent', () => {
		expect(() =>
			validateResource('emails', { subject: 'Thanks', body: 'Draft', status: 'sent' })
		).toThrow();
		expect(validateResource('emails', { subject: 'Thanks', body: 'Draft' })).toMatchObject({
			status: 'draft'
		});
	});

	it('rejects gift mutation and limits automation simulation to a no-send result', async () => {
		const sample = demoWorkspaces.riverstone.gifts[0];
		await expect(store.applyMutation('riverstone', 'gifts', sample, 'update')).rejects.toThrow(
			/immutable/i
		);
		const result = await store.applyMutation(
			'riverstone',
			'automations',
			{ name: 'Welcome flow' },
			'simulate'
		);
		expect(result.item).toMatchObject({ simulated: true, wouldSend: false });
	});

	it('rolls back the whole demo contact import when a duplicate appears after preview', async () => {
		const before = (await store.getWorkspace('riverstone'))!.contacts.length;
		await expect(
			store.importContactsDemo('riverstone', [
				{ name: 'New contact', email: 'new@example.test' },
				{ name: 'Existing contact', email: 'maya.chen@example.test' }
			])
		).rejects.toThrow(/no records were imported/i);
		expect((await store.getWorkspace('riverstone'))!.contacts).toHaveLength(before);
	});

	it('rejects relationships to IDs outside the active demo tenant', async () => {
		await expect(
			store.applyMutation('riverstone', 'relationships', {
				fromId: '00000000-0000-4000-8000-000000000000',
				toId: demoWorkspaces.riverstone.contacts[0].id,
				kind: 'knows',
				evidence: 'manual review'
			})
		).rejects.toThrow(/active tenant/i);
	});
});
