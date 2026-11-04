import { Ajv } from 'ajv';
import addFormats from 'ajv-formats';

const withFormats = addFormats as unknown as (ajv: Ajv) => Ajv;

/** The options `ManifestValidator.ajv()` in `@spinajs/validation` builds its two instances with. */
export function serverAjv(coerce: boolean): Ajv {
  return withFormats(new Ajv({ strict: false, strictNumbers: true, allErrors: true, messages: false, coerceTypes: coerce ? 'array' : false }));
}

export function describeInput(value: unknown): string {
  if (typeof value === 'string') {
    return `${JSON.stringify(value)} [${[...value].map((c) => c.codePointAt(0)!.toString(16)).join(' ')}]`;
  }
  if (Object.is(value, -0)) {
    return '-0';
  }
  return typeof value === 'number' ? String(value) : JSON.stringify(value);
}
