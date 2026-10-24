import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import schema from '../src/lib/openapi.generated.json';
import { mutationSchema, contactImportRowSchema } from '../src/lib/server/domain';
describe('Generated OpenAPI contracts', () => {
	it('matches the server validation schemas', () => {
		expect(schema.components.schemas.WorkspaceMutation).toEqual(z.toJSONSchema(mutationSchema));
		expect(schema.components.schemas.ContactImportRow).toEqual(
			z.toJSONSchema(contactImportRowSchema)
		);
	});
});
