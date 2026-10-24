import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

test.describe.configure({ timeout: 60_000 });

async function openDemo(page: Page) {
	await page.goto('/');
	await page.waitForLoadState('domcontentloaded');
	const demoButton = page.getByRole('button', { name: /explore the demo/i });
	await expect(demoButton).toBeEnabled();
	await demoButton.click();
	await expect(page).toHaveURL(/\/app\/riverstone\/overview$/);
	await expect(page.getByRole('heading', { name: /small moments/i })).toBeVisible();
}

async function expectAccessible(page: Page, surface: string) {
	const result = await new AxeBuilder({ page })
		.withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
		.analyze();
	const violations = result.violations.map(({ id, impact, help, nodes }) => ({
		id,
		impact,
		help,
		samples: nodes.slice(0, 6).map((node) => ({
			selector: node.target.join(' '),
			failure: node.failureSummary
		}))
	}));
	expect(
		violations,
		`${surface} accessibility violations: ${JSON.stringify(violations, null, 2)}`
	).toEqual([]);
}

test('contacts listing and donor detail pass axe', async ({ page }) => {
	await openDemo(page);
	await page.goto('/app/riverstone/contacts');
	await expect(page.getByRole('table')).toBeVisible();
	await expectAccessible(page, 'contacts listing');
	await page.locator('a[href*="/app/riverstone/contacts/"]').first().click();
	await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
	await expectAccessible(page, 'contact detail');
});

test('gift recording dialog passes axe', async ({ page }) => {
	await openDemo(page);
	await page.goto('/app/riverstone/gifts');
	await page.getByRole('button', { name: 'Record a gift' }).click();
	const dialog = page.getByRole('dialog', { name: 'Record an offline gift' });
	await expect(dialog).toBeVisible();
	await expectAccessible(page, 'gift recording dialog');
});

test('settings pass axe in light and dark color modes', async ({ page }) => {
	await openDemo(page);
	await page.goto('/app/riverstone/settings/general');
	const mode = page.getByLabel('Color mode');
	await expect(mode).toBeVisible();
	await mode.selectOption('light');
	await expect(page.locator('html')).not.toHaveClass(/dark/);
	await expectAccessible(page, 'settings light mode');
	await mode.selectOption('dark');
	await expect(page.locator('html')).toHaveClass(/dark/);
	await expectAccessible(page, 'settings dark mode');
});

test('public donation preview passes axe without exposing payment fields', async ({ page }) => {
	await openDemo(page);
	const campaignId = await page.evaluate(async () => {
		const response = await fetch('/api/v1/workspace?tenant=riverstone');
		const workspace = await response.json();
		return workspace.campaigns[0].id as string;
	});
	await page.goto(`/donate/riverstone/${campaignId}`);
	await expect(page.getByRole('heading', { name: /a place to grow/i })).toBeVisible();
	await expect(page.getByRole('button', { name: /continue to secure payment/i })).toBeDisabled();
	await expect(
		page.locator(
			'iframe[src*="stripe"], input[autocomplete="cc-number"], input[name="cardnumber"], input[name="cvc"]'
		)
	).toHaveCount(0);
	await expectAccessible(page, 'public donation preview');
});
