import { readFileSync } from 'node:fs';
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
let staffCookies: Awaited<ReturnType<import('@playwright/test').BrowserContext['cookies']>>;
test.beforeAll(async ({ browser }) => {
	const context = await browser.newContext();
	const r = await context.request.post('http://127.0.0.1:4174/api/v1/session', {
		data: {
			tenant: 'riverstone',
			email: 'browser@example.test',
			password: 'Browser-only-test-password-2026!'
		}
	});
	expect(r.status(), await r.text()).toBe(200);
	staffCookies = await context.cookies();
	await context.close();
});
test.beforeEach(async ({ context }) => {
	await context.addCookies(staffCookies);
});
test('staff can document consent, record finance, correct it, and reconcile reports', async ({
	page
}) => {
	const baseline = await (await page.request.get('/api/v1/reports/insights?currency=USD')).json();
	const n = Date.now(),
		name = `Browser donor ${n}`;
	await page.goto('/app/riverstone/contacts');
	await page.getByRole('button', { name: 'Add a person' }).click();
	const dialog = page.getByRole('dialog', { name: 'Add a person' });
	await dialog.getByLabel('Full name').fill(name);
	await dialog.getByLabel('Email address').fill(`browser-${n}@example.test`);
	await dialog.getByRole('button', { name: 'Save person' }).click();
	await expect(dialog).not.toBeVisible();
	await page.getByLabel('Search people').fill(name);
	const bounded = await (
		await page.request.get('/api/v1/workspace?compact=true&tenant=riverstone')
	).json();
	expect(bounded.contacts.some((item: { name: string }) => item.name === name)).toBe(false);
	await page.getByRole('link', { name, exact: true }).click();
	await page.getByRole('tab', { name: 'Details', exact: true }).click();
	await expect(page.getByRole('heading', { name: /ways to stay in touch/i })).toBeVisible();
	await page.getByRole('button', { name: 'consent', exact: true }).click();
	await page.getByLabel('Source / evidence').fill('Browser test explicit donor consent');
	await page.getByRole('button', { name: 'Save consent', exact: true }).click();
	await expect(page.getByText(/Browser test explicit donor consent/).first()).toBeVisible();
	await page.goto('/app/riverstone/gifts');
	await page.waitForLoadState('networkidle');
	await page.getByRole('button', { name: 'Record a gift', exact: true }).click();
	const gift = page.getByRole('dialog', { name: 'Record an offline gift' });
	await gift.getByRole('combobox', { name: 'Donor / credited supporter' }).fill(name);
	await gift.getByRole('option').filter({ hasText: name }).click();
	await gift.getByLabel('Amount', { exact: true }).fill('123.45');
	await gift.getByRole('button', { name: 'Confirm reviewed record' }).click();
	await expect(page.getByRole('table').getByText('$123.45', { exact: true })).toBeVisible();
	const row = page.getByRole('row').filter({ hasText: name }).filter({ hasText: '$123.45' });
	await row.getByRole('button', { name: 'Correct', exact: true }).click();
	const correction = page.getByRole('dialog', { name: 'Review a correcting event' });
	await correction.getByLabel('Amount', { exact: true }).fill('23.45');
	await correction
		.getByLabel('Reason', { exact: true })
		.fill('Browser verified partial refund correction');
	await correction.getByRole('checkbox').check();
	await correction.getByRole('button', { name: 'Confirm reviewed record' }).click();
	await expect(page.getByRole('table').getByText('$23.45', { exact: true })).toBeVisible();
	await expect(page.getByRole('table').getByText('$123.45', { exact: true })).toBeVisible();
	await page.goto('/app/riverstone/households');
	await page.getByRole('button', { name: 'Add household', exact: true }).click();
	const household = page.getByRole('dialog');
	await household
		.getByRole('textbox', { name: 'Name', exact: true })
		.fill(`Browser household ${n}`);
	await household.getByRole('combobox', { name: 'Find a household member' }).fill(name);
	await household.getByRole('option').filter({ hasText: name }).click();
	await household.getByRole('button', { name: 'Save household', exact: true }).click();
	const householdRow = page.getByRole('row').filter({ hasText: `Browser household ${n}` });
	await expect(householdRow).toContainText(name);
	await expect(householdRow).toContainText('$100.00');
	const reconciled = await (await page.request.get('/api/v1/reports/insights?currency=USD')).json();
	expect(reconciled.ledger.grossMinor).toBe(baseline.ledger.grossMinor + 12345);
	expect(reconciled.ledger.netRecordedMinor).toBe(baseline.ledger.netRecordedMinor + 10000);
	await page.goto('/app/riverstone/reports');
	await expect(page.getByRole('heading', { name: /Understand your impact/ })).toBeVisible();
	await expect(page.getByText('Net after known fees', { exact: true })).toBeVisible();
	await expect(page.getByRole('table').first()).toBeVisible();
	await expect(page.getByRole('alert')).toHaveCount(0);
	const blocked = await page.request.get('/api/v1/workspace?tenant=harbor');
	expect(blocked.status()).toBe(403);
});
test('tasks, account security, workflows, campaigns, events and AI show usable screens', async ({
	page
}) => {
	for (const [path, heading] of [
		['tasks', 'Stewardship'],
		['settings/security', 'People and security'],
		['automations', 'Automations'],
		['campaigns', 'A story worth sharing'],
		['events', 'Event manager'],
		['ai', '']
	] as const) {
		await page.goto(`/app/riverstone/${path}`);
		if (heading)
			await expect(
				page.getByRole('heading', { name: new RegExp(heading, 'i') }).first()
			).toBeVisible();
		await expect(page.locator('main')).toBeVisible();
		if (path === 'automations')
			await expect(page.getByRole('button', { name: 'New workflow', exact: true })).toBeVisible();
		const errors = await page.getByRole('alert').allTextContents();
		expect(errors.filter((x) => !/provider|key|price|disabled|configure/i.test(x))).toEqual([]);
	}
});
test('public free event RSVP is linked to a staff check-in', async ({ page }) => {
	const eventId = process.env.BROWSER_EVENT_ID,
		ticketId = process.env.BROWSER_TICKET_ID;
	expect(eventId).toBeTruthy();
	expect(ticketId).toBeTruthy();
	const guest = `Browser Event Guest ${Date.now()}`;
	await page.goto('/events/riverstone/browser-free-event');
	await page.getByLabel('Ticket or RSVP').selectOption(ticketId!);
	await page.getByLabel('Your name').fill(guest);
	await page.getByLabel('Email address').fill(`guest-${Date.now()}@example.test`);
	await page.getByRole('button', { name: 'Register' }).click();
	await expect(page.getByRole('heading', { name: 'You’re on the list.' })).toBeVisible();
	await page.goto('/app/riverstone/events');
	const listed = await page.request.get('/api/v1/events');
	expect(listed.ok()).toBeTruthy();
	expect((await listed.json()).events.some((item: { id: string }) => item.id === eventId)).toBe(
		true
	);
	await page.getByRole('button', { name: /Browser Community Gathering/ }).click();
	await expect(page.getByText(guest, { exact: true })).toBeVisible();
	await page.getByRole('button', { name: 'Check in' }).click();
	await expect(page.getByLabel('Checked in')).toBeVisible();
});
test('donor portal sign-in link is single-use and scopes the browser session', async ({ page }) => {
	const token = process.env.PORTAL_BROWSER_TOKEN,
		email = process.env.PORTAL_BROWSER_EMAIL,
		name = process.env.PORTAL_BROWSER_CONTACT_NAME;
	expect(token).toBeTruthy();
	expect(email).toBeTruthy();
	expect(name).toBeTruthy();
	await page.goto('/portal');
	await page.getByLabel('Organization workspace').fill('riverstone');
	await page.getByLabel('Email address').fill(email!);
	await page.getByRole('button', { name: 'Email me a sign-in link' }).click();
	await expect(page.getByRole('status')).toContainText('If an eligible donor account matches');
	await page.goto(`/portal/verify/${encodeURIComponent(token!)}`);
	await page.getByRole('button', { name: 'Continue to your portal' }).click();
	await expect(page).toHaveURL(/\/portal$/);
	await expect(page.getByRole('heading', { name: `Hello, ${name!.split(' ')[0]}.` })).toBeVisible();
	await expect(page.getByText(`Signed in as ${email}`)).toBeVisible();
	await page.goto(`/portal/verify/${encodeURIComponent(token!)}`);
	await page.getByRole('button', { name: 'Continue to your portal' }).click();
	await expect(page.getByRole('alert')).toContainText('invalid or expired');
});
test('new directory, giving, reports and security are accessible', async ({ page }) => {
	for (const path of ['contacts', 'gifts', 'reports', 'settings/security']) {
		await page.goto(`/app/riverstone/${path}`);
		await page.waitForTimeout(300);
		const result = await new AxeBuilder({ page })
			.withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
			.analyze();
		expect(
			result.violations.map((v) => ({ id: v.id, targets: v.nodes.map((n) => n.target) })),
			path
		).toEqual([]);
	}
});

test('mobile dark mode keeps finance and directories accessible', async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto('/app/riverstone/settings/general');
	await page.getByLabel('Color mode').selectOption('dark');
	await expect(page.locator('html')).toHaveClass(/dark/);
	for (const path of ['contacts', 'organizations', 'households', 'segments', 'gifts', 'reports']) {
		await page.goto(`/app/riverstone/${path}`);
		await expect(page.locator('html')).toHaveClass(/dark/);
		await page.waitForTimeout(250);
		const result = await new AxeBuilder({ page })
			.withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
			.analyze();
		expect(
			result.violations.map((v) => ({ id: v.id, targets: v.nodes.map((n) => n.target) })),
			path
		).toEqual([]);
		expect(
			await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
			`${path} horizontal page overflow`
		).toBe(true);
	}
});

test('recurring stewardship persists and workflow simulation leaves tasks unchanged', async ({
	page
}) => {
	const name = `Browser follow-up ${Date.now()}`;
	await page.goto('/app/riverstone/tasks');
	await page.getByLabel('Task title', { exact: true }).fill(name);
	await page.getByRole('combobox', { name: 'Repeat', exact: true }).selectOption('weekly');
	await page.getByRole('combobox', { name: 'Contact (optional)', exact: true }).fill('Maya Chen');
	await page.getByRole('option').filter({ hasText: 'Maya Chen' }).click();
	await page.getByRole('button', { name: 'Save task', exact: true }).click();
	const row = page.getByRole('listitem').filter({ hasText: name });
	await expect(row).toBeVisible();
	await row.getByRole('button', { name: 'Complete', exact: true }).click();
	await page.reload();
	await expect(
		page.getByRole('listitem').filter({ hasText: name }).filter({ hasText: 'completed' })
	).toBeVisible();
	await page.goto('/app/riverstone/automations');
	await page.getByLabel('Workflow name').fill(`Browser simulation ${Date.now()}`);
	await page.getByRole('button', { name: 'Save draft', exact: true }).click();
	await expect(
		page.getByRole('status').filter({ hasText: 'Draft saved as a new immutable version.' })
	).toBeVisible();
	await page.getByRole('button', { name: 'Validate', exact: true }).click();
	await expect(
		page.getByRole('status').filter({ hasText: 'Workflow definition is valid.' })
	).toBeVisible();
	await page
		.getByRole('combobox', { name: 'Contact for simulation or manual launch' })
		.fill('Maya Chen');
	await page.getByRole('option').filter({ hasText: 'Maya Chen' }).click();
	const before = await (await page.request.get('/api/v1/tasks')).json();
	await page.getByRole('button', { name: 'Simulate draft', exact: true }).click();
	await expect(
		page.getByRole('status').filter({ hasText: /Simulation completed.*no records changed/ })
	).toBeVisible();
	const after = await (await page.request.get('/api/v1/tasks')).json();
	expect(after.tasks.map((t: { id: string }) => t.id).sort()).toEqual(
		before.tasks.map((t: { id: string }) => t.id).sort()
	);
});

test('registered filing intake rejects unsafe XML and imports reviewed public evidence', async ({
	page
}) => {
	await page.goto('/app/riverstone/prospects');
	const sourceName = `Browser IRS source ${Date.now()}`;
	const register = page.locator('.source-form');
	await register.getByLabel('Source name').fill(sourceName);
	await register.getByRole('combobox', { name: 'Type', exact: true }).selectOption('public_filing');
	await register
		.getByLabel('License / rights basis')
		.fill('MIT licensed public IRS test fixture; internal research only');
	await register
		.getByLabel('Source URL')
		.fill('https://apps.irs.gov/pub/epostcard/990/xml/browser-fixture.xml');
	await register.getByRole('button', { name: 'Save source rights' }).click();
	await expect(
		page.getByRole('status').filter({ hasText: 'Research settings saved.' })
	).toBeVisible();
	const sourceResponse = await page.request.get('/api/v1/research/workbench?tenant=riverstone');
	const sources = (await sourceResponse.json()).sources;
	const source = sources.find((item: { name: string }) => item.name === sourceName);
	expect(source).toBeTruthy();
	const intake = page.locator('.import-form');
	await intake.getByRole('combobox', { name: 'Registered IRS source' }).selectOption(source.id);
	await intake
		.getByLabel('Or paste a single XML return')
		.fill('<!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><foo>&xxe;</foo>');
	await intake.getByRole('button', { name: 'Preview filings' }).click();
	await expect(
		page.getByRole('alert').filter({ hasText: 'XML document types and entities are not allowed' })
	).toBeVisible();
	await intake
		.getByLabel('Or paste a single XML return')
		.fill(
			readFileSync(
				new URL('../fixtures/irs-990pf-johnson-patient-assistance.xml', import.meta.url),
				'utf8'
			)
		);
	await intake.getByRole('button', { name: 'Preview filings' }).click();
	await expect(page.getByRole('heading', { name: /Candidate review/ })).toBeVisible();
	await page.getByRole('button', { name: 'Import selected reviewed records' }).click();
	await expect(
		page.getByRole('status').filter({ hasText: /reviewed prospect records imported/ })
	).toBeVisible();
	await page.reload();
	await expect(page.getByText(sourceName, { exact: true })).toBeVisible();
});

test('email studio creates a draft and reopens its persisted version without sending', async ({
	page
}) => {
	const subject = `Browser email draft ${Date.now()}`;
	await page.goto('/app/riverstone/email');
	await expect(page.getByRole('heading', { name: 'Email studio', exact: true })).toBeVisible();
	await page.getByLabel('Subject', { exact: true }).fill(subject);
	await page
		.getByLabel('Plain-text fallback')
		.fill('Reviewed local browser fixture; this message stays an unsent draft.');
	await page.getByRole('button', { name: 'Save draft', exact: true }).click();
	await expect(page.getByRole('status').filter({ hasText: 'Draft saved.' })).toBeVisible();
	const workspace = await (
		await page.request.get('/api/v1/workspace?compact=true&tenant=riverstone')
	).json();
	const draft = workspace.emails.find((item: { subject: string }) => item.subject === subject);
	expect(draft).toBeTruthy();
	expect(draft.status).toBe('draft');
	await page.goto(`/app/riverstone/email/${draft.id}`);
	await expect(page.getByLabel('Subject', { exact: true })).toHaveValue(subject);
	await page.getByLabel('Subject', { exact: true }).fill(subject + ' updated');
	await page.getByRole('button', { name: 'Save draft', exact: true }).click();
	await expect(page.getByRole('status').filter({ hasText: 'Draft saved.' })).toBeVisible();
	await page.reload();
	await expect(page.getByLabel('Subject', { exact: true })).toHaveValue(subject + ' updated');
});
