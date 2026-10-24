import { it, expect } from 'vitest';
import { majorToMinor, minorToMajor, currencyExponent, formatMoney } from '../src/lib/money';
it('handles ISO zero, two and three decimal currencies without float rounding', () => {
	expect(currencyExponent('JPY')).toBe(0);
	expect(majorToMinor('123', 'JPY')).toBe(123);
	expect(majorToMinor('12.34', 'USD')).toBe(1234);
	expect(majorToMinor('0.001', 'BHD')).toBe(1);
	expect(minorToMajor(123, 'JPY')).toBe(123);
	expect(formatMoney(123, 'JPY', 'en-US')).toContain('123');
	expect(() => majorToMinor('1.001', 'USD')).toThrow(/decimal/);
	expect(() => majorToMinor('9007199254740992', 'JPY')).toThrow(/range/);
});
