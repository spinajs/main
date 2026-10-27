import { manifestSchema } from './schema.js';

type Schema = Record<string, any>;

const definitions: Record<string, Schema> = manifestSchema.definitions;

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function matchesType(type: string, value: unknown): boolean {
  const actual = typeOf(value);
  if (type === 'integer') return Number.isInteger(value);
  return type === actual;
}

function check(schema: Schema | boolean, value: unknown, path: string, errors: string[]): void {
  if (typeof schema === 'boolean') {
    if (!schema) errors.push(`${path}: not allowed`);
    return;
  }

  if (schema.$ref) {
    const target = definitions[decodeURIComponent(String(schema.$ref).replace('#/definitions/', ''))];
    if (!target) {
      errors.push(`${path}: unresolved reference ${schema.$ref}`);
      return;
    }
    check(target, value, path, errors);
    return;
  }

  if (schema.anyOf) {
    const attempts = (schema.anyOf as Schema[]).map((s) => {
      const sub: string[] = [];
      check(s, value, path, sub);
      return sub;
    });
    if (!attempts.some((a) => a.length === 0)) errors.push(`${path}: does not match any allowed shape (${attempts.map((a) => a[0]).join(' | ')})`);
    return;
  }

  if ('const' in schema && value !== schema.const) {
    errors.push(`${path}: expected ${JSON.stringify(schema.const)}`);
    return;
  }
  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${path}: expected one of ${schema.enum.map((e: unknown) => JSON.stringify(e)).join(', ')}`);
    return;
  }
  if (schema.type) {
    const types: string[] = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => matchesType(t, value))) {
      errors.push(`${path}: expected ${types.join(' or ')}, got ${typeOf(value)}`);
      return;
    }
  }

  if (Array.isArray(value)) {
    if (schema.items !== undefined) value.forEach((item, i) => check(schema.items, item, `${path}[${i}]`, errors));
    return;
  }

  if (typeOf(value) === 'object') {
    const obj = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (!(key in obj)) errors.push(`${path}.${key}: required`);
    }
    const props: Record<string, Schema> = schema.properties ?? {};
    for (const [key, item] of Object.entries(obj)) {
      if (key in props) check(props[key], item, `${path}.${key}`, errors);
      else if (schema.additionalProperties !== undefined) check(schema.additionalProperties, item, `${path}.${key}`, errors);
    }
  }
}

function validateAgainst(name: string, value: unknown): string[] {
  const errors: string[] = [];
  check({ $ref: `#/definitions/${name}` }, value, '$', errors);
  return errors;
}

export const validateManifest = (value: unknown): string[] => validateAgainst('Manifest', value);
export const validateFragment = (value: unknown): string[] => validateAgainst('ManifestFragment', value);
