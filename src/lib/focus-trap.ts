/** Trap modal focus and restore it to the invoking control on close. */
export function focusTrap(node: HTMLElement) {
	const previous = document.activeElement as HTMLElement | null;
	const selectors =
		'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex="0"]';
	const frame = requestAnimationFrame(() =>
		(node.querySelector<HTMLElement>(selectors) || node).focus()
	);
	function keydown(event: KeyboardEvent) {
		if (event.key !== 'Tab') return;
		const items = Array.from(node.querySelectorAll<HTMLElement>(selectors)).filter(
			(e) => e.getClientRects().length > 0
		);
		if (!items.length) {
			event.preventDefault();
			node.focus();
			return;
		}
		const first = items[0],
			last = items[items.length - 1];
		if (event.shiftKey && (document.activeElement === first || document.activeElement === node)) {
			event.preventDefault();
			last.focus();
		} else if (!event.shiftKey && document.activeElement === last) {
			event.preventDefault();
			first.focus();
		}
	}
	node.addEventListener('keydown', keydown);
	return {
		destroy() {
			cancelAnimationFrame(frame);
			node.removeEventListener('keydown', keydown);
			previous?.focus();
		}
	};
}
