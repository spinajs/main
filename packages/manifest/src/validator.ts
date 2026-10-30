import { Ajv } from 'ajv';
import type { ErrorObject, ValidateFunction } from 'ajv';
import { manifestSchema } from './schema.js';

const compiled = new Map<string, ValidateFunction>();
let ajv: Ajv | undefined;

function compile(name: string): ValidateFunction {
  let validate = compiled.get(name);
  if (!validate) {
    ajv ??= new Ajv({ strict: true, allErrors: true });
    validate = ajv.compile({ $schema: manifestSchema.$schema, $ref: `#/definitions/${name}`, definitions: manifestSchema.definitions });
    compiled.set(name, validate);
  }
  return validate;
}

function jsonPath(instancePath: string): string {
  const segments = instancePath.split('/').slice(1).map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'));
  return segments.reduce((path, s) => (/^\d+$/.test(s) ? `${path}[${s}]` : `${path}.${s}`), '$');
}

function toMessage(e: ErrorObject): string {
  if (e.keyword === 'required') return `${jsonPath(e.instancePath)}.${(e.params as { missingProperty: string }).missingProperty}: required`;
  return `${jsonPath(e.instancePath)}: ${e.message ?? e.keyword}`;
}

function validateAgainst(name: string, value: unknown): string[] {
  const validate = compile(name);
  return validate(value) ? [] : (validate.errors ?? []).map(toMessage);
}

export const validateManifest = (value: unknown): string[] => validateAgainst('Manifest', value);
export const validateFragment = (value: unknown): string[] => validateAgainst('ManifestFragment', value);
