import { expect, test, type Page } from '@playwright/test';

async function openDemo(page: Page) {
	await page.goto('/');
	await page.waitForLoadState('networkidle');
	await page.waitForTimeout(400);
	const demoButton = page.getByRole('button', { name: /explore the demo/i });
	await expect(demoButton).toBeEnabled();
	await demoButton.click();
	await expect(page).toHaveURL(/\/app\/riverstone\/overview$/);
	await expect(page.getByRole('heading', { name: /small moments/i })).toBeVisible();
}

test('a delayed Riverstone refresh cannot replace the selected Harbor workspace', async ({
	page
}) => {
	await openDemo(page);
	const totalGiving = page.locator('.stat-main .big-number');
	const staleSentinelMinor = 987_654_321;
	const staleSentinelValue = '$9,876,543.21';
	let heldResponseStarted!: () => void;
	const heldResponse = new Promise<void>((resolve) => (heldResponseStarted = resolve));
	let releaseHeldResponse!: () => void;
	const responseRelease = new Promise<void>((resolve) => (releaseHeldResponse = resolve));
	let released = false;
	const riverstoneWorkspaceRequest = (url: URL) =>
		url.pathname === '/api/v1/workspace' && url.search === '?compact=true&tenant=riverstone';

	await page.getByRole('link', { name: 'Outreach' }).click();
	const subject = page.getByRole('textbox', { name: 'Subject' });
	await expect(subject).toBeEnabled();
	await page.route(riverstoneWorkspaceRequest, async (route) => {
		const response = await route.fetch();
		const body = await response.json();
		body.overview = { ...body.overview, grossMinor: staleSentinelMinor };
		heldResponseStarted();
		await responseRelease;
		await route.fulfill({
			status: response.status(),
			contentType: 'application/json',
			body: JSON.stringify(body)
		});
	});
	const harborWorkspaceLoaded = page.waitForResponse((response) => {
		const url = new URL(response.url());
		return (
			response.request().method() === 'GET' &&
			url.pathname === '/api/v1/workspace' &&
			url.search === '?compact=true&tenant=harbor'
		);
	});

	try {
		await subject.fill(`Race draft ${Date.now()}`);
		await page.getByRole('textbox', { name: 'Plain-text fallback' }).fill('Race test draft body.');
		await page.getByRole('button', { name: 'Save draft' }).click();
		await heldResponse;

		await page.getByLabel('Switch tenant').selectOption('harbor');
		await expect(page).toHaveURL(/\/app\/harbor\/overview$/);
		await harborWorkspaceLoaded;
		await expect(page.getByRole('heading', { name: /small moments/i })).toBeVisible();
		await expect(page.locator('.overview-stats')).toBeVisible();
		await expect
			.poll(() => totalGiving.innerText().then((value) => value.trim()))
			.not.toBe(staleSentinelValue);
		const harborValue = (await totalGiving.innerText()).trim();

		const staleDelivered = page.waitForResponse((response) =>
			riverstoneWorkspaceRequest(new URL(response.url()))
		);
		releaseHeldResponse();
		released = true;
		await staleDelivered;
		await page.evaluate(
			() =>
				new Promise<void>((resolve) =>
					requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
				)
		);
		await expect(page).toHaveURL(/\/app\/harbor\/overview$/);
		await expect(totalGiving).toHaveText(harborValue);
	} finally {
		if (!released) releaseHeldResponse();
		await page.unroute(riverstoneWorkspaceRequest);
	}
});
