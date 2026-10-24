import { expect, test, type Page } from '@playwright/test';
import { themes } from '../../src/lib/themes';

async function openDemo(page: Page) {
	await page.goto('/');
	await page.waitForLoadState('networkidle');
	const demoButton = page.getByRole('button', { name: /explore the demo/i });
	await expect(demoButton).toBeEnabled();
	await demoButton.click();
	await expect(page).toHaveURL(/\/app\/riverstone\/overview$/);
}

test('official themes keep semantic text colors readable in both modes', async ({ page }) => {
	await openDemo(page);
	await page.goto('/app/riverstone/settings/general');
	const modePicker = page.getByLabel('Color mode');

	for (const themeName of themes) {
		await page.locator(`button.theme-swatch[data-theme="${themeName}"]`).click();
		await expect(page.locator('html')).toHaveAttribute('data-theme', themeName);

		for (const mode of ['light', 'dark'] as const) {
			await modePicker.selectOption(mode);
			if (mode === 'dark') await expect(page.locator('html')).toHaveClass(/dark/);
			else await expect(page.locator('html')).not.toHaveClass(/dark/);

			const failures = await page.evaluate(() => {
				const canvas = document.createElement('canvas');
				const context = canvas.getContext('2d')!;
				const readRgb = (value: string) => {
					context.clearRect(0, 0, 1, 1);
					context.fillStyle = value;
					context.fillRect(0, 0, 1, 1);
					return Array.from(context.getImageData(0, 0, 1, 1).data).slice(0, 3);
				};
				const luminance = (channels: number[]) => {
					const linear = channels.map((channel) => {
						const normalized = channel / 255;
						return normalized <= 0.04045
							? normalized / 12.92
							: ((normalized + 0.055) / 1.055) ** 2.4;
					});
					return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
				};
				const contrast = (foreground: string, background: string) => {
					const [a, b] = [luminance(readRgb(foreground)), luminance(readRgb(background))].sort(
						(left, right) => right - left
					);
					return (a + 0.05) / (b + 0.05);
				};
				const probe = document.createElement('span');
				probe.style.position = 'fixed';
				probe.style.visibility = 'hidden';
				document.body.append(probe);
				const computed = (property: 'color' | 'backgroundColor', token: string) => {
					probe.style[property] = `var(--${token})`;
					return getComputedStyle(probe)[property];
				};
				const foregrounds = ['ink', 'muted', 'accent'];
				const backgrounds = ['paper', 'soft', 'white'];
				const results: string[] = [];
				for (const foreground of foregrounds) {
					for (const background of backgrounds) {
						const foregroundColor = computed('color', foreground);
						const backgroundColor = computed('backgroundColor', background);
						const ratio = contrast(foregroundColor, backgroundColor);
						if (ratio < 4.5)
							results.push(
								`${foreground} on ${background}: ${ratio.toFixed(2)}:1 (${foregroundColor} on ${backgroundColor})`
							);
					}
				}
				probe.remove();
				return results;
			});
			expect(failures, `${themeName} theme in ${mode} mode`).toEqual([]);
		}
	}
});
