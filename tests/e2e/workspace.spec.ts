import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { themes } from '../../src/lib/themes';

async function openDemo(page: Page) {
	await page.goto('/');
	await page.waitForLoadState('networkidle');
	// The demo entry point is a Svelte click handler, so allow client hydration to finish.
	await page.waitForTimeout(400);
	const demoButton = page.getByRole('button', { name: /explore the demo/i });
	await expect(demoButton).toBeEnabled();
	await demoButton.click();
	await expect(page).toHaveURL(/\/app\/riverstone\/overview$/);
	await expect(page.getByRole('heading', { name: /small moments/i })).toBeVisible();
}

test('demo login, donor records, stewardship, giving, search, settings, and tenant boundaries', async ({
	page
}) => {
	await openDemo(page);

	// Contact mutations survive a full browser reload.
	const contactName = `Playwright Donor ${Date.now()}`;
	await page.getByRole('link', { name: 'People' }).click();
	await page.getByRole('button', { name: 'Add a person' }).click();
	const contactDialog = page.getByRole('dialog', { name: 'Add a person' });
	await contactDialog.getByLabel('Full name').fill(contactName);
	await contactDialog.getByLabel('Email address').fill(`pw-${Date.now()}@example.test`);
	await contactDialog.getByRole('button', { name: 'Save person' }).click();
	await page.getByLabel('Search people').fill(contactName);
	await expect(page.getByRole('row').filter({ hasText: contactName })).toBeVisible();
	await page.reload();
	await page.getByLabel('Search people').fill(contactName);
	await expect(page.getByRole('row').filter({ hasText: contactName })).toBeVisible();

	// Tasks use the synthetic demo store and persist through the demo task API.
	await page.goto('/app/riverstone/tasks');
	const taskTitle = `Playwright follow-up ${Date.now()}`;
	await page.getByLabel('Task title').fill(taskTitle);
	await page.getByRole('button', { name: 'Save task' }).click();
	const task = page.locator('.items li').filter({ hasText: taskTitle });
	await expect(task).toBeVisible();
	await task.getByRole('button', { name: 'Complete' }).click();
	await expect(task).toContainText('completed');
	await page.reload();
	await expect(page.locator('.items li').filter({ hasText: taskTitle })).toContainText('completed');

	// Record an offline gift through the current giving manager; no payment is charged.
	await page.goto('/app/riverstone/gifts');
	await page.getByRole('button', { name: 'Record a gift' }).click();
	const giftDialog = page.getByRole('dialog');
	await expect(giftDialog).toBeVisible();
	const giftAmount = (20 + (Date.now() % 7000) / 100).toFixed(2);
	await giftDialog.getByLabel('Amount').fill(giftAmount);
	await giftDialog.getByLabel('Payment method').selectOption('cash');
	await giftDialog.getByRole('button', { name: 'Confirm reviewed record' }).click();
	await expect(page.getByRole('table').getByText(`$${giftAmount}`, { exact: true })).toBeVisible();

	// Keyboard search returns the newly created donor in the active workspace.
	await page.keyboard.press('Control+k');
	const searchDialog = page.getByRole('dialog', { name: 'Search workspace' });
	await searchDialog.getByLabel('Search everything').fill(contactName);
	await expect(searchDialog.getByRole('link', { name: new RegExp(contactName) })).toBeVisible();
	await searchDialog.getByLabel('Close search').click();

	// Theme options come from the installed Skeleton package; selection and mode persist locally.
	await page.goto('/app/riverstone/settings/general');
	const swatches = page.locator('button.theme-swatch');
	await expect(swatches).toHaveCount(themes.length);
	for (const themeName of themes)
		await expect(page.locator(`button.theme-swatch[data-theme="${themeName}"]`)).toBeVisible();
	const selectedTheme = (await swatches.nth(0).locator('span').last().innerText())
		.trim()
		.toLowerCase();
	await swatches.nth(0).click();
	await expect(page.locator('html')).toHaveAttribute('data-theme', selectedTheme);
	await page.getByLabel('Color mode').selectOption('dark');
	await expect(page.locator('html')).toHaveClass(/dark/);
	await page.reload();
	await expect(page.locator('html')).toHaveAttribute('data-theme', selectedTheme);
	await expect(page.locator('html')).toHaveClass(/dark/);

	// A valid session cannot read another tenant by changing the request parameter.
	const crossTenant = await page.evaluate(async () => {
		const response = await fetch('/api/v1/workspace?tenant=harbor');
		return { status: response.status, body: await response.json() };
	});
	expect(crossTenant.status).toBe(403);
	expect(crossTenant.body.error).toMatch(/active session/i);

	// The directory's inline CSV dry run marks a known tenant email as a duplicate.
	await page.goto('/app/riverstone/contacts');
	const activeEmail = await page.evaluate(async () => {
		const response = await fetch('/api/v1/workspace?tenant=riverstone');
		const workspace = await response.json();
		return workspace.contacts.find((contact: { email?: string }) => contact.email)?.email as string;
	});
	await page.getByRole('button', { name: 'Import' }).click();
	const importPanel = page
		.locator('.panel')
		.filter({ has: page.getByRole('heading', { name: 'Review a contact import' }) });
	await importPanel.getByLabel('CSV content').fill(`name,email\nDuplicate preview,${activeEmail}`);
	await importPanel.getByRole('button', { name: 'Dry-run import' }).click();
	await expect(importPanel).toContainText('0 ready · 1 duplicate · 0 invalid');
});

test('create and review collection records, documented paths, and reject hostile filing XML', async ({
	page
}) => {
	test.setTimeout(60_000);
	await openDemo(page);
	const suffix = Date.now();

	const householdName = `Playwright Household ${suffix}`;
	await page.goto('/app/riverstone/households');
	await page.getByRole('button', { name: 'Add household' }).click();
	let dialog = page.getByRole('dialog');
	await expect(dialog).toBeVisible();
	await page.waitForTimeout(250);
	await dialog.getByRole('textbox', { name: 'Name' }).fill(householdName);
	await dialog.getByLabel('Maya Chen').check();
	await dialog.getByRole('button', { name: 'Save household' }).click();
	let household = page.getByRole('row').filter({ hasText: householdName });
	await expect(household).toContainText('Maya Chen');
	await page.reload();
	household = page.getByRole('row').filter({ hasText: householdName });
	await expect(household).toContainText('Maya Chen');

	const organizationName = `Playwright Organization ${suffix}`;
	await page.goto('/app/riverstone/organizations');
	await page.getByRole('button', { name: 'Add organization' }).click();
	dialog = page.getByRole('dialog');
	await expect(dialog).toBeVisible();
	await page.waitForTimeout(250);
	await dialog.getByRole('textbox', { name: 'Name' }).fill(organizationName);
	await dialog.getByLabel('Organization type').selectOption('Nonprofit');
	await dialog.getByLabel('Website').fill('https://example.test/playwright');
	await dialog.getByRole('button', { name: 'Save organization' }).click();
	let organization = page.getByRole('row').filter({ hasText: organizationName });
	await expect(organization).toContainText('Nonprofit');
	await page.reload();
	organization = page.getByRole('row').filter({ hasText: organizationName });
	await expect(organization).toContainText('Nonprofit');
	await organization.getByRole('button', { name: 'Edit', exact: true }).click();
	dialog = page.getByRole('dialog');
	await expect(dialog).toBeVisible();
	await page.waitForTimeout(250);
	await dialog.getByLabel('Website').fill('https://example.test/updated');
	await dialog.getByRole('button', { name: 'Save changes' }).click();
	await expect(
		page
			.getByRole('row')
			.filter({ hasText: organizationName })
			.getByRole('link', { name: 'Website' })
	).toHaveAttribute('href', 'https://example.test/updated');

	const segmentName = `Playwright Segment ${suffix}`;
	await page.goto('/app/riverstone/segments');
	await page.getByRole('button', { name: 'Add segment' }).click();
	dialog = page.getByRole('dialog');
	await expect(dialog).toBeVisible();
	await page.waitForTimeout(250);
	await dialog.getByRole('textbox', { name: 'Name' }).fill(segmentName);
	await dialog.getByLabel('Contact field').selectOption('stage');
	await dialog.getByLabel('Match').selectOption('equals');
	await dialog.getByLabel('Value').fill('Volunteer');
	await dialog.getByRole('button', { name: 'Save segment' }).click();
	let segment = page.getByRole('row').filter({ hasText: segmentName });
	await expect(segment.getByRole('cell', { name: '3', exact: true })).toBeVisible();
	await page.reload();
	segment = page.getByRole('row').filter({ hasText: segmentName });
	await expect(segment.getByRole('cell', { name: '3', exact: true })).toBeVisible();

	// Event management is explicitly unavailable in demo mode rather than attempting DB writes.
	const demoEvents = await page.evaluate(async () => {
		const response = await fetch('/api/v1/events');
		return { status: response.status, body: await response.json() };
	});
	expect(demoEvents.status).toBe(503);
	expect(demoEvents.body.error).toMatch(/unavailable in demo mode/i);
	const unavailableDemoManagers = await page.evaluate(async () => {
		const responses = await Promise.all([fetch('/api/v1/campaigns'), fetch('/api/v1/automations')]);
		return Promise.all(
			responses.map(async (response) => ({ status: response.status, body: await response.json() }))
		);
	});
	for (const result of unavailableDemoManagers) {
		expect(result.status).toBe(503);
		expect(result.body.error).toMatch(/persistent storage|unavailable in demo mode/i);
	}

	await page.goto('/app/riverstone/relationships');
	const pathForm = page.locator('.path-search');
	const fromSelect = pathForm.locator('select').nth(0);
	const toSelect = pathForm.locator('select').nth(1);
	const graceOption = fromSelect.locator('option').filter({ hasText: /^Grace Kim · person$/ });
	const jordanOption = toSelect.locator('option').filter({ hasText: /^Jordan Ellis · person$/ });
	const [graceId, jordanId] = await Promise.all([
		graceOption.getAttribute('value'),
		jordanOption.getAttribute('value')
	]);
	expect(graceId).toBeTruthy();
	expect(jordanId).toBeTruthy();
	await fromSelect.selectOption(graceId!);
	await toSelect.selectOption(jordanId!);
	const findPathButton = page.getByRole('button', { name: 'Find documented paths' });
	await expect(findPathButton).toBeEnabled();
	await findPathButton.click();
	const pathResult = page.locator('.path-results article').first();
	await expect(pathResult).toContainText('PATH 1 · 1 step');
	await expect(pathResult).toContainText('Grace Kim — serves on board');
	await expect(pathResult).toContainText('Jordan Ellis');

	await page.goto('/app/riverstone/prospects');
	await expect(page.getByRole('heading', { name: 'Filing intake' })).toBeVisible();
	const hostileFiling = await page.evaluate(async () => {
		const response = await fetch('/api/v1/research/jobs', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				tenant: 'riverstone',
				sourceUrl: 'https://apps.irs.gov/pub/epostcard/990/xml/synthetic.xml',
				xml: '<!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><foo>&xxe;</foo>',
				apply: false
			})
		});
		return { status: response.status, body: await response.json() };
	});
	expect(hostileFiling.status).toBe(422);
	expect(hostileFiling.body.error).toContain('XML document types and entities are not allowed');
});

test('public donation preview makes no payment request or raw card fields available', async ({
	page
}) => {
	await openDemo(page);
	const campaignId = await page.evaluate(async () => {
		const response = await fetch('/api/v1/workspace?tenant=riverstone');
		const workspace = await response.json();
		return workspace.campaigns[0].id as string;
	});
	await page.goto(`/donate/riverstone/${campaignId}`);
	await expect(page.getByRole('heading', { name: /a place to grow/i })).toBeVisible();
	await expect(page.getByText(/synthetic preview cannot accept payments/i)).toBeVisible();
	await expect(page.getByRole('button', { name: /continue to secure payment/i })).toBeDisabled();
	await expect(
		page.locator(
			'iframe[src*="stripe"], input[autocomplete="cc-number"], input[name="cardnumber"], input[name="cvc"]'
		)
	).toHaveCount(0);
	await expect(page.locator('img[src="/brand/generous-dots.svg"]').first()).toBeVisible();
});

test('overview passes axe checks and fits a mobile viewport without horizontal overflow', async ({
	page
}) => {
	await openDemo(page);
	const desktop = await new AxeBuilder({ page })
		.withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
		.analyze();

	await page.setViewportSize({ width: 390, height: 844 });
	const dimensions = await page.evaluate(() => ({
		viewport: document.documentElement.clientWidth,
		document: document.documentElement.scrollWidth,
		body: document.body.scrollWidth
	}));
	expect(
		dimensions.document,
		`document overflows at mobile width: ${JSON.stringify(dimensions)}`
	).toBeLessThanOrEqual(dimensions.viewport);
	expect(
		dimensions.body,
		`body overflows at mobile width: ${JSON.stringify(dimensions)}`
	).toBeLessThanOrEqual(dimensions.viewport);
	const mobile = await new AxeBuilder({ page })
		.withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
		.analyze();
	const summarize = (violations: typeof desktop.violations) =>
		violations.map(({ id, impact, nodes }) => ({
			id,
			impact,
			samples: nodes
				.slice(0, 5)
				.map((node) => ({ selector: node.target.join(' '), details: node.any[0]?.data }))
		}));
	const violations = {
		desktop: summarize(desktop.violations),
		mobile: summarize(mobile.violations)
	};
	expect(violations, JSON.stringify(violations, null, 2)).toEqual({ desktop: [], mobile: [] });
});
