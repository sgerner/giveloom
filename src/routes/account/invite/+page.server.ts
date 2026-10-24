export function load({ url, locals }) {
	return {
		token: url.searchParams.get('token') ?? '',
		signedIn: Boolean(locals.session && !locals.session.demo)
	};
}
