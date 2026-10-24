import { describe, expect, it } from 'vitest';
import { stripeGiftExternalEventId } from '../src/lib/server/payments';

describe('Stripe immutable ledger event keys', () => {
	const eventPayloads = [
		['payment_intent.succeeded', { id: 'pi_replay' }, 'stripe:payment_intent:pi_replay'],
		['invoice.paid', { id: 'in_replay' }, 'stripe:invoice:in_replay'],
		['refund.created', { id: 're_replay', status: 'succeeded' }, 'stripe:refund:re_replay'],
		['charge.dispute.created', { id: 'dp_replay' }, 'stripe:dispute:dp_replay:created'],
		['charge.dispute.closed', { id: 'dp_replay', status: 'won' }, 'stripe:dispute:dp_replay:won']
	] as const;

	it.each(eventPayloads)('derives a stable gift key for %s replays', (type, object, expected) => {
		expect(stripeGiftExternalEventId(type, object)).toBe(expected);
		expect(stripeGiftExternalEventId(type, structuredClone(object))).toBe(expected);
	});

	it('does not create a new ledger gift for a failed refund or lost dispute closure', () => {
		expect(
			stripeGiftExternalEventId('refund.updated', { id: 're_failed', status: 'failed' })
		).toBeNull();
		expect(
			stripeGiftExternalEventId('charge.dispute.closed', { id: 'dp_lost', status: 'lost' })
		).toBeNull();
	});
});
