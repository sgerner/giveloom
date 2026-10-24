export function load({ url }) {
	return { token: url.searchParams.get('token') ?? '' };
}
