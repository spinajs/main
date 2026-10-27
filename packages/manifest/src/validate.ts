import { manifestSchema } from './schema.js';

interface SchemaNode {
  $ref?: string;
  type?: string | string[];
  const?: unknown;
  enum?: unknown[];
  anyOf?: SchemaNode[];
  items?: SchemaNode;
  required?: string[];
  properties?: Record<string, SchemaNode>;
  additionalProperties?: SchemaNode | boolean;
}

type Errors = string[];

const definitions = manifestSchema.definitions as Record<string, SchemaNode>;

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function checkRef(ref: string, value: unknown, path: string, errors: Errors): void {
  const target = definitions[decodeURIComponent(ref.replace('#/definitions/', ''))];
  if (target) check(target, value, path, errors);
  else errors.push(`${path}: unresolved reference ${ref}`);
}

function checkAnyOf(options: SchemaNode[], value: unknown, path: string, errors: Errors): void {
  const attempts = options.map((s) => {
    const sub: Errors = [];
    check(s, value, path, sub);
    return sub;
  });
  if (!attempts.some((a) => a.length === 0)) errors.push(`${path}: does not match any allowed shape (${attempts.map((a) => a[0]).join(' | ')})`);
}

function checkType(type: string | string[], value: unknown, path: string, errors: Errors): boolean {
  const types = Array.isArray(type) ? type : [type];
  const actual = typeOf(value);
  if (types.some((t) => t === actual || (t === 'integer' && Number.isInteger(value)))) return true;
  errors.push(`${path}: expected ${types.join(' or ')}, got ${actual}`);
  return false;
}

function checkLiteral(schema: SchemaNode, value: unknown, path: string, errors: Errors): boolean {
  if ('const' in schema && value !== schema.const) {
    errors.push(`${path}: expected ${JSON.stringify(schema.const)}`);
    return false;
  }
  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${path}: expected one of ${schema.enum.map((e) => JSON.stringify(e)).join(', ')}`);
    return false;
  }
  return true;
}

function checkObject(schema: SchemaNode, obj: Record<string, unknown>, path: string, errors: Errors): void {
  for (const key of schema.required ?? []) {
    if (!(key in obj)) errors.push(`${path}.${key}: required`);
  }
  const props = new Map(Object.entries(schema.properties ?? {}));
  for (const [key, item] of Object.entries(obj)) {
    const known = props.get(key);
    if (known) check(known, item, `${path}.${key}`, errors);
    else if (typeof schema.additionalProperties === 'object') check(schema.additionalProperties, item, `${path}.${key}`, errors);
  }
}

function check(schema: SchemaNode, value: unknown, path: string, errors: Errors): void {
  if (schema.$ref) return checkRef(schema.$ref, value, path, errors);
  if (schema.anyOf) return checkAnyOf(schema.anyOf, value, path, errors);
  if (!checkLiteral(schema, value, path, errors)) return;
  if (schema.type && !checkType(schema.type, value, path, errors)) return;

  if (Array.isArray(value)) {
    const items = schema.items;
    if (items) value.forEach((item, i) => check(items, item, `${path}[${i}]`, errors));
  } else if (typeOf(value) === 'object') {
    checkObject(schema, value as Record<string, unknown>, path, errors);
  }
}

function validateAgainst(name: string, value: unknown): Errors {
  const errors: Errors = [];
  check({ $ref: `#/definitions/${name}` }, value, '$', errors);
  return errors;
}

export const validateManifest = (value: unknown): string[] => validateAgainst('Manifest', value);
export const validateFragment = (value: unknown): string[] => validateAgainst('ManifestFragment', value);
