import { describe, expect, it } from 'vitest';
import { renderGiftReceiptHtml } from '../src/lib/server/receipts';

describe('gift receipt rendering', () => {
	it('escapes all tenant and donor values and states the acknowledgment limitation', () => {
		const html = renderGiftReceiptHtml({
			receiptNumber: 'G-TEST',
			organization: '<img src=x onerror=alert(1)>',
			donorName: 'A & B',
			amountDisplay: '$25.00',
			giftDate: 'October 23, 2026',
			campaignName: 'Appeal <2026>',
			disclaimer: 'Not tax advice.'
		});
		expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
		expect(html).toContain('A &amp; B');
		expect(html).toContain('Appeal &lt;2026&gt;');
		expect(html).toContain('Not tax advice.');
		expect(html).not.toContain('<img src=x');
	});
});
