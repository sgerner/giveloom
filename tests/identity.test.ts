import { describe, it, expect } from 'vitest';
import { canonicalContactId } from '../src/lib/identity';
describe('Canonical donor identity', () => {
	it('resolves merge chains without rewriting gift ownership', () => {
		expect(
			canonicalContactId('a', [
				{ id: 'a', mergedInto: 'b' },
				{ id: 'b', mergedInto: 'c' }
			])
		).toBe('c');
		expect(canonicalContactId('z', [])).toBe('z');
	});
	it('terminates for corrupt cycles', () => {
		expect(
			canonicalContactId('a', [
				{ id: 'a', mergedInto: 'b' },
				{ id: 'b', mergedInto: 'a' }
			])
		).toBe('a');
	});
});
