export async function load({ params, setHeaders }) {
	setHeaders({ 'cache-control': 'no-store' });
	return { token: params.token };
}
