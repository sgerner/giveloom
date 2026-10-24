export function load({ url }) {
	return {
		token: url.searchParams.get('token') ?? '',
		tenant: url.searchParams.get('tenant') ?? ''
	};
}
