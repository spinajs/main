import { Ajv } from 'ajv';
import addFormats from 'ajv-formats';
import { addKeywordPluginsOnUse } from '@spinajs/configuration';
import type { Manifest } from '@spinajs/manifest';
import { ManifestValidator, type ManifestValidationOptions } from '@spinajs/validation';

const withFormats = addFormats as unknown as (ajv: Ajv) => Ajv;

/**
 * `ManifestValidator` with what `DataValidator` adds: `$data`, ajv-keywords and ajv-merge-patch. Those keywords come
 * only from explicit `@Schema` classes, and `DataValidator` is what validates such a class as an argument.
 */
export class PluginValidator extends ManifestValidator {
  protected ajv(coerce: boolean): Ajv {
    let ajv = this.instances.get(coerce);
    if (!ajv) {
      ajv = withFormats(new Ajv({ strict: false, strictNumbers: true, allErrors: true, messages: false, coerceTypes: coerce ? 'array' : false, $data: true }));
      addKeywordPluginsOnUse(ajv);
      for (const schema of this.schemas.values()) this.add(ajv, schema);
      this.instances.set(coerce, ajv);
    }
    return ajv;
  }
}

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

export const validatorFor = (manifest: Manifest, plugins: boolean): ManifestValidator => (plugins ? new PluginValidator(manifest) : new ManifestValidator(manifest));
