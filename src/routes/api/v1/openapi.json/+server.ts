import { json } from '@sveltejs/kit';
import schema from '$lib/openapi.generated.json';
export function GET() {
	return json(schema);
}
