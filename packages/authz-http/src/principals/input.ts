import { DI } from '@spinajs/di';
import { DataValidator } from '@spinajs/validation';

/**
 * `value` checked against an `authz.` field schema by the app's DataValidator. Resolved per call: principal sources are
 * global middlewares, and a test builds them without the container.
 */
export async function isValidInput(schema: { readonly $id: string }, value: unknown): Promise<boolean> {
  const validator = await DI.resolve(DataValidator);
  const [valid] = validator.tryValidate(schema, value as object);
  return valid;
}
