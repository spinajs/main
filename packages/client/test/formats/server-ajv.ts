import type { Ajv } from 'ajv';
import type { Manifest } from '@spinajs/manifest';
import { ManifestValidator } from '@spinajs/validation';

/** Exposes the Ajv instance the server validates route arguments with, so a change of its options reaches these tests. */
class ServerValidator extends ManifestValidator {
  public instance(coerce: boolean): Ajv {
    return this.ajv(coerce);
  }
}

export function serverAjv(coerce: boolean): Ajv {
  return new ServerValidator({ schemas: {} } as unknown as Manifest).instance(coerce);
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
