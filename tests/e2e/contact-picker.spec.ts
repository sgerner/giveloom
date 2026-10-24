import { expect, test, type Page } from '@playwright/test';

async function openDemo(page: Page) {
	await page.goto('/');
	await page.waitForLoadState('networkidle');
	await page.waitForTimeout(400);
	const demoButton = page.getByRole('button', { name: /explore the demo/i });
	await expect(demoButton).toBeEnabled();
	await demoButton.click();
	await expect(page).toHaveURL(/\/app\/riverstone\/overview$/);
}

async function openRecordGift(page: Page) {
	await page.goto('/app/riverstone/gifts');
	await page.getByRole('button', { name: 'Record a gift' }).click();
	return page.getByRole('dialog');
}

const maya = {
	id: '00000000-0000-4000-8000-000000000001',
	name: 'Maya Chen',
	email: 'maya@example.test'
};
const amara = {
	id: '00000000-0000-4000-8000-000000000002',
	name: 'Amara Lee',
	email: 'amara@example.test'
};

test('typing after choosing a supporter invalidates the selection and anonymous entry clears the query', async ({
	page
}) => {
	await openDemo(page);
	await page.route('**/api/v1/contacts?**', async (route) => {
		const query = new URL(route.request().url()).searchParams.get('q')?.toLowerCase();
		const items = query?.includes('amara') ? [amara] : [maya];
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ items, nextCursor: null })
		});
	});

	const dialog = await openRecordGift(page);
	const donorSearch = dialog.getByRole('combobox', { name: 'Donor / credited supporter' });
	await donorSearch.fill('Maya');
	await page.getByRole('option', { name: /Maya Chen/ }).click();
	await expect(donorSearch).toHaveAttribute('placeholder', 'Maya Chen');

	await donorSearch.fill('Amara');
	await expect(donorSearch).toHaveAttribute('placeholder', 'Search by name or email…');
	await expect(page.getByRole('option', { name: /Amara Lee/ })).toBeVisible();
	await expect(dialog.getByRole('button', { name: 'Clear selected supporter' })).toHaveCount(0);
	await expect
		.poll(() => donorSearch.evaluate((input: HTMLInputElement) => input.validity.valid))
		.toBe(false);

	await dialog.getByLabel('Amount', { exact: true }).fill('25');
	let giftPostCount = 0;
	page.on('request', (request) => {
		if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/v1/giving')
			giftPostCount += 1;
	});
	await dialog.getByRole('button', { name: 'Confirm reviewed record' }).click();
	await expect.poll(() => giftPostCount).toBe(0);

	await dialog.getByRole('button', { name: 'Record as anonymous / unassigned' }).click();
	await expect(donorSearch).toHaveValue('');
	await expect
		.poll(() => donorSearch.evaluate((input: HTMLInputElement) => input.validity.valid))
		.toBe(true);
});

test('a delayed load-more response cannot reopen results after selecting a supporter', async ({
	page
}) => {
	await openDemo(page);
	let loadMoreStarted!: () => void;
	const loadMoreRequest = new Promise<void>((resolve) => (loadMoreStarted = resolve));
	let releaseLoadMore!: () => void;
	const delayedResponse = new Promise<void>((resolve) => (releaseLoadMore = resolve));
	await page.route('**/api/v1/contacts?**', async (route) => {
		const url = new URL(route.request().url());
		if (url.searchParams.has('cursor')) {
			loadMoreStarted();
			await delayedResponse;
			await route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({ items: [amara], nextCursor: null })
			});
			return;
		}
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ items: [maya], nextCursor: 'page-2' })
		});
	});

	const dialog = await openRecordGift(page);
	const donorSearch = dialog.getByRole('combobox', { name: 'Donor / credited supporter' });
	await donorSearch.fill('Maya');
	await page.getByRole('option', { name: /Maya Chen/ }).click();
	await donorSearch.fill('Maya');
	await page.getByRole('option', { name: /Maya Chen/ }).waitFor();
	await dialog.getByRole('button', { name: 'Load more supporters' }).click();
	await loadMoreRequest;

	await page.getByRole('option', { name: /Maya Chen/ }).click();
	await expect(dialog.getByRole('listbox')).toHaveCount(0);
	// Let the in-flight page complete after choose() has invalidated its request id.
	const responseDone = page.waitForResponse((response) => response.url().includes('cursor=page-2'));
	releaseLoadMore();
	await responseDone;
	await page.evaluate(
		() =>
			new Promise<void>((resolve) =>
				requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
			)
	);
	await expect(dialog.getByRole('listbox')).toHaveCount(0);
	await expect(dialog.getByRole('option', { name: /Amara Lee/ })).toHaveCount(0);
});
