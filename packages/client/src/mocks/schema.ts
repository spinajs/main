import { ajvEqual, ajvMultipleOf, formatPredicate, maxCodePoints, minCodePoints } from '../formats/index.js';
import type { MockIssue } from './errors.js';
import { parsePattern } from './pattern.js';

export type Json = Record<string, unknown>;

/**
 * A JSON Schema (draft-07) node. `$ref` is a name in the schema table, optionally with a JSON pointer into it
 * (`Name#/$defs/x`); a bare `#…` pointer resolves against the schema being mocked.
 */
export type MockSchema = boolean | { [keyword: string]: unknown };

export type MockSchemas = Readonly<Record<string, MockSchema>>;

/** Names a mock never writes as an object key. */
export const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

const JSON_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'null', 'array', 'object']);
const DRAFT_07 = new Set(['http://json-schema.org/draft-07/schema#', 'http://json-schema.org/draft-07/schema']);
const ANNOTATIONS = new Set(['title', 'description', '$comment', 'examples', 'default', 'readOnly', 'writeOnly', 'deprecated', '$id', '$defs', 'definitions', 'contentMediaType', 'contentEncoding']);
const NUMBERS = new Set(['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf']);
const COUNTS = new Set(['minLength', 'maxLength', 'minItems', 'maxItems']);
const SCHEMA_LISTS = ['allOf', 'anyOf', 'oneOf'] as const;
const HANDLED = new Set<string>([
  ...NUMBERS,
  ...COUNTS,
  ...SCHEMA_LISTS,
  '$schema',
  'type',
  'enum',
  'const',
  'nullable',
  '$ref',
  'pattern',
  'format',
  'items',
  'additionalItems',
  'uniqueItems',
  'properties',
  'required',
  'additionalProperties',
  'patternProperties',
]);

export const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);
export const own = (object: object, key: string): unknown => (Object.hasOwn(object, key) ? (object as Json)[key] : undefined);
export const list = (value: unknown): unknown[] => (Array.isArray(value) ? (value as unknown[]) : []);

/** The JSON types a node allows by its `type` and `nullable`, or `undefined` for any. */
export function typesOf(node: Json): string[] | undefined {
  const type = node.type;
  if (type === undefined) return undefined;
  const types = (Array.isArray(type) ? type : [type]) as string[];
  return node.nullable === true ? [...types, 'null'] : types;
}

export function hasForbiddenKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasForbiddenKey);
  if (!isObject(value)) return false;
  return Object.keys(value).some((key) => FORBIDDEN_KEYS.has(key) || hasForbiddenKey(value[key]));
}

export function isValidRegex(source: string): boolean {
  try {
    new RegExp(source, 'u');
    return true;
  } catch {
    return false;
  }
}

function unescapePointer(segment: string): string {
  return decodeURIComponent(segment).replace(/~1/g, '/').replace(/~0/g, '~');
}

/** The schema a `$ref` points at, and the name its own relative refs resolve against. */
export function resolveRef(schemas: MockSchemas, ref: string, base: string): { schema: MockSchema; base: string } | undefined {
  const hash = ref.indexOf('#');
  const name = hash === 0 ? base : hash > 0 ? ref.slice(0, hash) : ref;
  const pointer = hash >= 0 ? ref.slice(hash + 1) : '';
  if (pointer !== '' && !pointer.startsWith('/')) return undefined;
  let node: unknown = own(schemas, name);
  try {
    for (const segment of pointer === '' ? [] : pointer.slice(1).split('/')) {
      const key = unescapePointer(segment);
      node = Array.isArray(node) ? (node as unknown[])[Number(key)] : isObject(node) ? own(node, key) : undefined;
    }
  } catch {
    return undefined;
  }
  return typeof node === 'boolean' || isObject(node) ? { schema: node, base: name } : undefined;
}

export function hasType(value: unknown, type: string): boolean {
  if (type === 'integer') return Number.isInteger(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (type === 'null') return value === null;
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return isObject(value);
  return typeof value === type;
}

function fitsString(value: string, node: Json): boolean {
  if (typeof node.minLength === 'number' && !minCodePoints(node.minLength)(value)) return false;
  if (typeof node.maxLength === 'number' && !maxCodePoints(node.maxLength)(value)) return false;
  if (typeof node.pattern === 'string' && !new RegExp(node.pattern, 'u').test(value)) return false;
  const format = typeof node.format === 'string' ? formatPredicate(node.format) : undefined;
  return !format || format(value);
}

function fitsNumber(value: number, node: Json): boolean {
  const { minimum, maximum, exclusiveMinimum, exclusiveMaximum, multipleOf } = node;
  if (typeof minimum === 'number' && value < minimum) return false;
  if (typeof maximum === 'number' && value > maximum) return false;
  if (typeof exclusiveMinimum === 'number' && value <= exclusiveMinimum) return false;
  if (typeof exclusiveMaximum === 'number' && value >= exclusiveMaximum) return false;
  return typeof multipleOf !== 'number' || ajvMultipleOf(multipleOf)(value);
}

/** Whether a value satisfies the scalar keywords of one node (type, const, enum, string and number checks), as Ajv checks them. */
export function fitsNode(value: unknown, node: Json): boolean {
  const types = typesOf(node);
  if (types && !types.some((t) => hasType(value, t))) return false;
  if ('const' in node && !ajvEqual(value, node.const)) return false;
  if (Array.isArray(node.enum) && !node.enum.some((member) => ajvEqual(value, member))) return false;
  if (typeof value === 'string') return fitsString(value, node);
  if (typeof value === 'number') return fitsNumber(value, node);
  return true;
}

/** The scalar `examples` and `default` of a node that pass its own checks. */
export function usableExamples(node: Json): unknown[] {
  const candidates = [...list(node.examples), ...('default' in node ? [node.default] : [])];
  return candidates.filter((value) => (value === null || ['string', 'number', 'boolean'].includes(typeof value)) && fitsNode(value, node));
}

/** Whether a schema accepts every value: `true`, or annotations only. */
export function acceptsAnything(schema: unknown): boolean {
  return schema === true || (isObject(schema) && Object.keys(schema).every((key) => key.startsWith('x-') || ANNOTATIONS.has(key)));
}

/**
 * Ajv reads a declared property as `data[name]`, so a missing `toString` or `valueOf` is checked as the inherited
 * function and fails its schema. A mock writes such a property whenever it is declared.
 */
export function isInheritedName(name: string): boolean {
  return Object.hasOwn(Object.prototype, name) && !FORBIDDEN_KEYS.has(name);
}

const escape = (segment: string | number): string => String(segment).replace(/~/g, '~0').replace(/\//g, '~1');

/** The subschemas of a node, with their JSON pointer paths relative to it. */
export function subschemas(node: Json): [string, unknown][] {
  const out: [string, unknown][] = [];
  for (const key of ['properties', 'patternProperties'] as const) {
    const map = node[key];
    if (isObject(map)) out.push(...Object.keys(map).map((name): [string, unknown] => [`${key}/${escape(name)}`, map[name]]));
  }
  for (const key of ['additionalProperties', 'additionalItems', 'items'] as const) {
    const value = node[key];
    if (Array.isArray(value)) out.push(...value.map((child, i): [string, unknown] => [`${key}/${i}`, child]));
    else if (value !== undefined) out.push([key, value]);
  }
  for (const key of SCHEMA_LISTS) out.push(...list(node[key]).map((child, i): [string, unknown] => [`${key}/${i}`, child]));
  return out;
}

type At = (key: string, message: string) => MockIssue;

interface Local {
  issue?: MockIssue;
  /** Every `$ref` of the schema, with the name it points into. */
  refs: { schema: string; pointer: string; target: string }[];
}

interface Shape {
  types?: string[];
  tags: Map<string, unknown[]>;
}

function disjoint(a: Shape, b: Shape): boolean {
  const overlap = (x: string, y: string) => x === y || (x === 'integer' && y === 'number') || (x === 'number' && y === 'integer');
  if (a.types && b.types && !a.types.some((x) => b.types!.some((y) => overlap(x, y)))) return true;
  return [...a.tags].some(([name, values]) => b.tags.has(name) && !values.some((v) => b.tags.get(name)!.some((w) => ajvEqual(v, w))));
}

/** Walks one schema without following `$ref`s; a schema is unsupported when any schema it reaches has a local issue. */
class Analysis {
  constructor(
    private readonly schemas: MockSchemas,
    private readonly cache: Map<string, MockIssue | null>,
  ) {}

  public named(name: string): MockIssue | undefined {
    const cached = this.cache.get(name);
    if (cached !== undefined) return cached ?? undefined;
    const schema = own(this.schemas, name) as MockSchema | undefined;
    const issue = schema === undefined ? { schema: name, pointer: '', message: 'no such schema' } : this.reached(this.local(schema, name));
    this.cache.set(name, issue ?? null);
    return issue;
  }

  public inline(schema: MockSchema, label: string): MockIssue | undefined {
    return this.reached(this.local(schema, label));
  }

  private reached(local: Local): MockIssue | undefined {
    if (local.issue) return local.issue;
    const seen = new Set<string>();
    for (const ref of local.refs) {
      const issue = this.firstIssue(ref.target, seen);
      if (issue) return { schema: ref.schema, pointer: ref.pointer, message: `references ${ref.target}: ${issue.message}` };
    }
    return undefined;
  }

  private firstIssue(name: string, seen: Set<string>): MockIssue | undefined {
    if (seen.has(name)) return undefined;
    seen.add(name);
    const local = this.local(own(this.schemas, name) as MockSchema, name);
    if (local.issue) return local.issue;
    for (const ref of local.refs) {
      const issue = this.firstIssue(ref.target, seen);
      if (issue) return issue;
    }
    return undefined;
  }

  private local(schema: MockSchema, base: string): Local {
    const local: Local = { refs: [] };
    local.issue = this.node(schema, base, '', local);
    // A pointer ref (`Name#/$defs/x`) counts as a ref to the whole schema, so its $defs are walked too.
    for (const key of ['$defs', 'definitions']) {
      const defs = isObject(schema) ? schema[key] : undefined;
      for (const name of Object.keys(isObject(defs) ? defs : {})) local.issue ??= this.node((defs as Json)[name], base, `/${key}/${escape(name)}`, local);
    }
    return local;
  }

  private node(schema: unknown, base: string, pointer: string, local: Local): MockIssue | undefined {
    if (typeof schema === 'boolean') return undefined;
    const at: At = (key, message) => ({ schema: base, pointer: `${pointer}/${escape(key)}`, message });
    if (!isObject(schema)) return { schema: base, pointer, message: 'a schema must be an object or a boolean' };
    for (const key of Object.keys(schema)) {
      const issue = key.startsWith('x-') || ANNOTATIONS.has(key) ? undefined : this.keyword(schema, key, at, base);
      if (issue) return issue;
    }
    if (typeof schema.$ref === 'string') {
      const target = resolveRef(this.schemas, schema.$ref, base);
      if (!target) return at('$ref', `$ref ${schema.$ref} does not resolve`);
      local.refs.push({ schema: base, pointer: `${pointer}/$ref`, target: target.base });
    }
    for (const [path, child] of subschemas(schema)) {
      const issue = this.node(child, base, `${pointer}/${path}`, local);
      if (issue) return issue;
    }
    return undefined;
  }

  private keyword(node: Json, key: string, at: At, base: string): MockIssue | undefined {
    const value = node[key];
    if (!HANDLED.has(key)) return at(key, `keyword ${key} is not supported by the mock sampler`);
    if (isObject(value) && '$data' in value) return at(key, '$data references are not supported by the mock sampler');
    if (NUMBERS.has(key) || COUNTS.has(key)) return this.limit(key, value, at);
    switch (key) {
      case '$schema':
        return typeof value === 'string' && DRAFT_07.has(value) ? undefined : at(key, `$schema ${String(value)} is not draft-07, which the server validates with`);
      case 'type':
        return (typesOf(node) ?? []).every((t) => JSON_TYPES.has(t)) ? undefined : at(key, `type ${JSON.stringify(value)} is not a JSON type`);
      case 'pattern':
        return this.pattern(node, value, at);
      default:
        return this.objectKeyword(node, key, at) ?? this.listed(key, value, at, base);
    }
  }

  private objectKeyword(node: Json, key: string, at: At): MockIssue | undefined {
    if (key === 'patternProperties') return this.patternNames(node[key], at);
    if (key === 'required') return this.required(node, node[key], at);
    return key === 'properties' ? this.inheritedNames(node[key], at) : undefined;
  }

  private limit(key: string, value: unknown, at: At): MockIssue | undefined {
    if (NUMBERS.has(key)) return typeof value === 'number' && Number.isFinite(value) ? undefined : at(key, `${key} must be a number`);
    return Number.isInteger(value) && (value as number) >= 0 ? undefined : at(key, `${key} must be a non-negative integer`);
  }

  private listed(key: string, value: unknown, at: At, base: string): MockIssue | undefined {
    if (key === 'const' && hasForbiddenKey(value)) return at(key, 'const holds a key named __proto__, constructor or prototype');
    if (key === 'enum' && (!Array.isArray(value) || value.every(hasForbiddenKey))) return at(key, 'enum has no member a mock can hold');
    if (key === 'oneOf' && !this.exclusive(list(value), base)) return at(key, 'oneOf branches can match the same value, so the sampler cannot pick exactly one');
    return undefined;
  }

  private pattern(node: Json, value: unknown, at: At): MockIssue | undefined {
    if (typeof value !== 'string') return at('pattern', 'pattern must be a string');
    if (!isValidRegex(value)) return at('pattern', `pattern ${value} is not a valid u-flag regex, so the server refuses the schema`);
    if (parsePattern(value) || 'const' in node || usableExamples(node).length > 0) return undefined;
    return at('pattern', `pattern ${value} is outside the sampled regex subset, and the node has no valid examples, default or const`);
  }

  private inheritedNames(value: unknown, at: At): MockIssue | undefined {
    if (!isObject(value)) return undefined;
    // ManifestSchemaPreparer copies with plain assignment, so the property becomes the copy's prototype.
    if (Object.hasOwn(value, '__proto__')) return at('properties', 'a property named __proto__ becomes a prototype in the server schema preparation, and Ajv refuses the schema');
    if (Object.hasOwn(value, 'constructor') && !acceptsAnything(value.constructor)) {
      return at('properties', 'Ajv checks a missing property named constructor against the inherited Object constructor, and a mock cannot write that key');
    }
    return undefined;
  }

  private patternNames(value: unknown, at: At): MockIssue | undefined {
    const bad = Object.keys(isObject(value) ? value : {}).find((p) => !isValidRegex(p));
    return bad === undefined ? undefined : at('patternProperties', `pattern ${bad} is not a valid u-flag regex, so the server refuses the schema`);
  }

  private required(node: Json, value: unknown, at: At): MockIssue | undefined {
    if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) return at('required', 'required must be a list of names');
    const forbidden = value.find((name: string) => FORBIDDEN_KEYS.has(name));
    if (forbidden !== undefined) return at('required', `required property ${forbidden} cannot be written to a mock`);
    const properties = isObject(node.properties) ? node.properties : {};
    const patterns = Object.keys(isObject(node.patternProperties) ? node.patternProperties : {}).filter(isValidRegex);
    const closedOut = (name: string) => node.additionalProperties === false && !Object.hasOwn(properties, name) && !patterns.some((p) => new RegExp(p, 'u').test(name));
    const missing = value.find(closedOut);
    return missing === undefined ? undefined : at('required', `required property ${missing} is not allowed by additionalProperties: false`);
  }

  /** Whether no value can match two branches: their types are disjoint, or a required tag has disjoint values. */
  private exclusive(members: unknown[], base: string): boolean {
    const shapes = members.map((m) => this.shape(m, base));
    return shapes.every((a, i) => shapes.every((b, j) => j <= i || disjoint(a, b)));
  }

  private shape(member: unknown, base: string): Shape {
    let node = member;
    if (isObject(node) && typeof node.$ref === 'string') node = resolveRef(this.schemas, node.$ref, base)?.schema;
    if (!isObject(node)) return { tags: new Map() };
    const tags = new Map<string, unknown[]>();
    const properties = isObject(node.properties) ? node.properties : {};
    for (const name of list(node.required).filter((n): n is string => typeof n === 'string')) {
      const property = own(properties, name);
      if (isObject(property) && 'const' in property) tags.set(name, [property.const]);
      else if (isObject(property) && Array.isArray(property.enum)) tags.set(name, property.enum);
    }
    return { types: typesOf(node), tags };
  }
}

const ANALYSES = new WeakMap<object, Map<string, MockIssue | null>>();

function cacheOf(schemas: MockSchemas): Map<string, MockIssue | null> {
  let cache = ANALYSES.get(schemas);
  if (!cache) ANALYSES.set(schemas, (cache = new Map()));
  return cache;
}

/**
 * The first thing in schema `name`, or in a schema it references, that the sampler cannot honour (diagnostic
 * `MOCK001`): `not`, `if`, `$data`, a keyword it does not know, a pattern outside the regex subset without a usable
 * example, a schema the server's Ajv refuses, a required key named `__proto__`, `constructor` or `prototype`.
 */
export function mockIssue(schemas: MockSchemas, name: string): MockIssue | undefined {
  return new Analysis(schemas, cacheOf(schemas)).named(name);
}

/** {@link mockIssue} for a schema outside the table, such as a route's reply. */
export function schemaIssue(schemas: MockSchemas, schema: MockSchema, label: string): MockIssue | undefined {
  return new Analysis(schemas, cacheOf(schemas)).inline(schema, label);
}
