/** ISO currency fraction digits come from the runtime's maintained Intl data. */
export function currencyExponent(currency: string) {
	if (!/^[A-Z]{3}$/.test(currency) || !Intl.supportedValuesOf('currency').includes(currency))
		throw new Error('Choose a supported ISO 4217 currency.');
	return new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions()
		.maximumFractionDigits!;
}
export function minorToMajor(amountMinor: number, currency: string) {
	if (!Number.isSafeInteger(amountMinor))
		throw new Error('Money must use safe integer minor units.');
	return amountMinor / 10 ** currencyExponent(currency);
}
export function majorToMinor(value: string | number, currency: string) {
	const text = String(value).trim();
	if (!/^\d+(?:\.\d+)?$/.test(text)) throw new Error('Enter a nonnegative decimal amount.');
	const exponent = currencyExponent(currency);
	const [whole, fraction = ''] = text.split('.');
	if (fraction.length > exponent && /[1-9]/.test(fraction.slice(exponent)))
		throw new Error(`${currency} supports ${exponent} decimal places.`);
	const minor =
		BigInt(whole) * 10n ** BigInt(exponent) +
		BigInt(fraction.slice(0, exponent).padEnd(exponent, '0') || '0');
	if (minor > BigInt(Number.MAX_SAFE_INTEGER))
		throw new Error('Amount exceeds the supported range.');
	return Number(minor);
}
export function formatMoney(amountMinor: number, currency: string, locale?: string) {
	return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(
		minorToMajor(amountMinor, currency)
	);
}
