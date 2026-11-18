import type { Manifest } from '@spinajs/manifest';
import { ManifestValidator, type ManifestValidationOptions } from '@spinajs/validation';

/** The server's verdict on `value`: true when it accepts it. The value is copied, as coercion rewrites it. */
export function serverAccepts(validator: ManifestValidator, id: string, options: ManifestValidationOptions, value: unknown): boolean {
  try {
    validator.validator(id, options)(structuredClone(value));
    return true;
  } catch (error) {
    if ((error as Error).constructor.name === 'ValidationFailed') return false;
    throw error;
  }
}

export const validatorFor = (manifest: Manifest): ManifestValidator => new ManifestValidator(manifest);
