export function canonicalContactId(id: string, aliases: { id: string; mergedInto: string }[] = []) {
	const seen = new Set<string>();
	let current = id;
	while (current && !seen.has(current)) {
		seen.add(current);
		const alias = aliases.find((a) => a.id === current);
		if (!alias) break;
		current = alias.mergedInto;
	}
	return current;
}
