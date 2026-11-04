import { ajvEqual, numberFormatPredicate } from '../formats/index.js';
import { MockError, MockUnsupported } from './errors.js';
import { FORMAT_SAMPLERS, word } from './formats.js';
import { endsAnchored, parsePattern, samplePattern } from './pattern.js';
import { Rng } from './rng.js';
import { FORBIDDEN_KEYS, fitsNode, hasForbiddenKey, isObject, list, mockIssue, own, resolveRef, schemaIssue, typesOf, usableExamples, type Json, type MockSchema, type MockSchemas } from './schema.js';

export interface MockOptions {
  /** Default 1. The same seed, schema and overrides always give the same value. */
  seed?: number;
  /** `some` (default): each optional property appears on a seeded coin flip. `all`: every one appears, down to `maxDepth`. */
  optional?: 'some' | 'all';
  /** Nesting depth from which optional properties, optional items and recursive branches stop; default 3. */
  maxDepth?: number;
  /** A sampler per string format, for example one that calls faker; its values must still pass the format. */
  formats?: Partial<Record<string, (rng: Rng) => string>>;
}

/** A schema with the name its relative `#…` refs resolve against. */
interface Located {
  schema: unknown;
  base: string;
}

interface Part {
  node: Json;
  base: string;
}

interface Context {
  schemas: MockSchemas;
  optional: 'some' | 'all';
  maxDepth: number;
  formats: Partial<Record<string, (rng: Rng) => string>>;
  /** Sampling attempts left: retries at every level must not multiply without end. */
  budget: number;
}

const RETRIES = 12;
const RECURSION_LIMIT = 64;
const SCALARS = new Set(['null', 'boolean', 'integer', 'number', 'string']);
const OBJECT_KEYS = ['properties', 'required', 'additionalProperties', 'patternProperties'];
const ARRAY_KEYS = ['items', 'additionalItems', 'minItems', 'maxItems', 'uniqueItems'];
const STRING_KEYS = ['minLength', 'maxLength', 'pattern', 'format'];
const NUMBER_KEYS = ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf'];
const INT_RANGES: Record<string, [number, number]> = { int32: [-(2 ** 31), 2 ** 31 - 1], int64: [Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER] };

const unique = <T>(values: T[]): T[] => [...new Set(values)];
const codePoints = (s: string): number => [...s].length;

/** A copy without keys named `__proto__`, `constructor` or `prototype`, so a mock never shares state with a schema. */
function clone(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(clone);
  if (!isObject(value)) return value;
  const out: Json = {};
  for (const key of Object.keys(value)) if (!FORBIDDEN_KEYS.has(key)) out[key] = clone(value[key]);
  return out;
}

function opened(schema: Json): Json {
  const copy = { ...schema };
  delete copy.$id;
  delete copy.additionalProperties;
  return copy;
}

function isClosedObject(schema: unknown): schema is Json {
  return isObject(schema) && schema.additionalProperties === false && isObject(schema.properties) && !schema.anyOf && !schema.oneOf;
}

/** What the server's `ManifestSchemaPreparer` reads an `allOf` member as: only a plain ref to a whole schema is followed. */
function intersectionTarget(member: unknown, base: string, ctx: Context): Located | undefined {
  if (!isObject(member)) return undefined;
  if (typeof member.$ref !== 'string' || Object.keys(member).length !== 1) return { schema: member, base };
  const target = member.$ref.includes('#') ? undefined : own(ctx.schemas, member.$ref);
  if (target === undefined) return undefined;
  return { schema: isObject(target) && target['x-explicit'] === 'partial' ? {} : target, base: member.$ref };
}

class Sampler {
  constructor(private readonly ctx: Context) {}

  public sample(located: Located[], rng: Rng, depth: number): unknown {
    if (depth > this.ctx.maxDepth + RECURSION_LIMIT) throw new MockError('recursion does not end: a required property or item reaches its own schema again');
    let failure: unknown;
    for (let attempt = 0; attempt < RETRIES; attempt++) {
      if (this.ctx.budget-- <= 0) break;
      try {
        return this.once(located, attempt === 0 ? rng : rng.child(`#${attempt}`), depth);
      } catch (e) {
        if (!(e instanceof MockError)) throw e;
        failure = e;
      }
    }
    throw failure instanceof MockError ? failure : new MockError('gave up: the schema needs more attempts than the sampler allows');
  }

  private once(located: Located[], rng: Rng, depth: number): unknown {
    const parts: Part[] = [];
    const choices: { members: unknown[]; base: string }[] = [];
    for (const l of located) this.collect(l, parts, choices, 0);
    for (let i = 0; i < choices.length; i++) {
      if (i > RECURSION_LIMIT) throw new MockError('anyOf/oneOf nesting does not end');
      const branch = this.branch(choices[i].members, choices[i].base, rng.child(`|${i}`), depth);
      this.collect({ schema: branch, base: choices[i].base }, parts, choices, 0);
    }
    return this.parts(parts, rng, depth);
  }

  /** Flattens `$ref` and `allOf` into the list of nodes the value must satisfy, and queues `anyOf`/`oneOf`. */
  private collect({ schema, base }: Located, parts: Part[], choices: { members: unknown[]; base: string }[], hops: number): void {
    if (schema === false) throw new MockError('a false schema accepts no value');
    if (!isObject(schema)) return;
    if (hops > RECURSION_LIMIT) throw new MockError('the $ref chain does not end');
    if (typeof schema.$ref === 'string') {
      const target = resolveRef(this.ctx.schemas, schema.$ref, base);
      if (!target) throw new MockError(`$ref ${schema.$ref} does not resolve`);
      this.collect(target, parts, choices, hops + 1);
    }
    let node = schema;
    if (Array.isArray(schema.allOf)) node = this.intersection(schema, base, parts, choices, hops);
    for (const key of ['anyOf', 'oneOf']) if (Array.isArray(node[key])) choices.push({ members: node[key] as unknown[], base });
    parts.push({ node, base });
  }

  // Mirrors ManifestSchemaPreparer.intersection: closed members are opened and the node closed over their names.
  private intersection(node: Json, base: string, parts: Part[], choices: { members: unknown[]; base: string }[], hops: number): Json {
    const members = list(node.allOf);
    const targets = members.map((m) => intersectionTarget(m, base, this.ctx));
    if (!targets.every((t) => t !== undefined && isClosedObject(t.schema))) {
      for (const member of members) this.collect({ schema: member, base }, parts, choices, hops + 1);
      return node;
    }
    const names = new Set<string>();
    for (const target of targets as Located[]) {
      const closed = target.schema as Json;
      Object.keys(closed.properties as Json).forEach((name) => names.add(name));
      this.collect({ schema: opened(closed), base: target.base }, parts, choices, hops + 1);
    }
    const properties = { ...(isObject(node.properties) ? node.properties : {}), ...Object.fromEntries([...names].map((name) => [name, true])) };
    return { ...node, properties, additionalProperties: false };
  }

  private branch(members: unknown[], base: string, rng: Rng, depth: number): unknown {
    if (members.length === 0) throw new MockError('anyOf/oneOf without branches accepts no value');
    if (depth < this.ctx.maxDepth) return rng.pick(members);
    // Past maxDepth, a null or scalar branch ends the recursion.
    const score = (member: unknown): number => {
      const node = isObject(member) && typeof member.$ref === 'string' ? resolveRef(this.ctx.schemas, member.$ref, base)?.schema : member;
      const types = isObject(node) ? typesOf(node) : undefined;
      if (types?.includes('null')) return 0;
      return types?.every((t) => SCALARS.has(t)) ? 1 : 2;
    };
    const best = Math.min(...members.map(score));
    return rng.pick(members.filter((m) => score(m) === best));
  }

  private parts(parts: Part[], rng: Rng, depth: number): unknown {
    const nodes = parts.map((p) => p.node);
    const listed = nodes.find((n) => 'const' in n || Array.isArray(n.enum));
    if (listed) return this.listed(listed, nodes, rng);
    const examples = nodes.flatMap(usableExamples).filter((value) => nodes.every((n) => fitsNode(value, n)));
    if (examples.length > 0) return rng.pick(examples);
    const type = this.type(nodes, rng, depth);
    if (type === 'null') return null;
    if (type === 'boolean') return rng.chance();
    if (type === 'integer' || type === 'number') return sampleNumber(nodes, type === 'integer', rng);
    if (type === 'string') return this.string(nodes, rng);
    if (type === 'array') return this.array(parts, rng, depth);
    return this.object(parts, rng, depth);
  }

  private listed(node: Json, nodes: Json[], rng: Rng): unknown {
    const values = 'const' in node ? [node.const] : list(node.enum);
    const candidates = values.filter((value) => !hasForbiddenKey(value) && nodes.every((n) => fitsNode(value, n)));
    if (candidates.length === 0) throw new MockError('no const or enum value satisfies every schema of the node');
    return clone(rng.pick(candidates));
  }

  private type(nodes: Json[], rng: Rng, depth: number): string {
    let types: string[] | undefined;
    for (const node of nodes) {
      const allowed = typesOf(node);
      if (allowed) types = types ? intersectTypes(types, allowed) : unique(allowed);
    }
    types ??= [inferType(nodes)];
    if (nodes.some((n) => typeof n.format === 'string' && Object.hasOwn(INT_RANGES, n.format))) types = types.map((t) => (t === 'number' ? 'integer' : t));
    if (types.length === 0) throw new MockError('the schemas of the node allow no common type');
    if (depth >= this.ctx.maxDepth) {
      const ending = types.includes('null') ? ['null'] : types.filter((t) => SCALARS.has(t));
      if (ending.length > 0) return rng.pick(ending);
    }
    return rng.pick(types);
  }

  private string(nodes: Json[], rng: Rng): string {
    const min = Math.max(0, ...nodes.map((n) => (typeof n.minLength === 'number' ? n.minLength : 0)));
    const max = Math.min(...nodes.map((n) => (typeof n.maxLength === 'number' ? n.maxLength : Infinity)));
    const formats = unique(nodes.map((n) => n.format).filter((f): f is string => typeof f === 'string' && (Object.hasOwn(this.ctx.formats, f) || Object.hasOwn(FORMAT_SAMPLERS, f))));
    const patterns = unique(nodes.map((n) => n.pattern).filter((p): p is string => typeof p === 'string'));
    for (let attempt = 0; attempt < RETRIES && min <= max; attempt++) {
      const r = attempt === 0 ? rng : rng.child(`#${attempt}`);
      const target = min > 0 || max < Infinity ? r.int(min, Math.min(max, min + 8)) : r.int(3, 10);
      const value = formats.length > 0 ? this.formatted(formats[0], r, min) : patterns.length > 0 ? patterned(patterns[0], r, target, min) : target === 0 ? '' : word(r, target);
      if (nodes.every((n) => fitsNode(value, n))) return value;
    }
    throw new MockError(`no string of ${min} to ${max} code points${formats.length > 0 ? ` with format ${formats.join(', ')}` : ''}${patterns.length > 0 ? ` matching ${patterns.join(', ')}` : ''}`);
  }

  private formatted(format: string, rng: Rng, min: number): string {
    const app = own(this.ctx.formats, format);
    return typeof app === 'function' ? String((app as (rng: Rng) => unknown)(rng)) : FORMAT_SAMPLERS[format](rng, min);
  }

  private array(parts: Part[], rng: Rng, depth: number): unknown[] {
    const nodes = parts.map((p) => p.node);
    const min = Math.max(0, ...nodes.map((n) => (typeof n.minItems === 'number' ? n.minItems : 0)));
    const closedTuples = nodes.filter((n) => Array.isArray(n.items) && n.additionalItems === false).map((n) => (n.items as unknown[]).length);
    const max = Math.min(...nodes.map((n) => (typeof n.maxItems === 'number' ? n.maxItems : Infinity)), ...closedTuples);
    if (min > max) throw new MockError(`no array has ${min} to ${max} items`);
    const count = depth >= this.ctx.maxDepth ? min : rng.int(min, Math.min(max, min + 3));
    const distinct = nodes.some((n) => n.uniqueItems === true);
    const out: unknown[] = [];
    for (let i = 0; i < count; i++) {
      const located = parts.flatMap(({ node, base }): Located[] => {
        if (Array.isArray(node.items)) return [{ schema: i < node.items.length ? (node.items[i] as unknown) : (node.additionalItems ?? true), base }];
        return node.items === undefined ? [] : [{ schema: node.items, base }];
      });
      out.push(this.item(located, out, distinct, rng, i, depth));
    }
    return out;
  }

  private item(located: Located[], before: unknown[], distinct: boolean, rng: Rng, i: number, depth: number): unknown {
    for (let attempt = 0; attempt < RETRIES; attempt++) {
      const value = this.sample(located, attempt === 0 ? rng.child(i) : rng.child(`${i}#${attempt}`), depth + 1);
      if (!distinct || !before.some((other) => ajvEqual(other, value))) return value;
    }
    throw new MockError('uniqueItems: the item schema gives too few distinct values');
  }

  private object(parts: Part[], rng: Rng, depth: number): Json {
    const declared: string[] = [];
    const required = new Set<string>();
    for (const { node } of parts) {
      declared.push(...Object.keys(isObject(node.properties) ? node.properties : {}));
      for (const name of list(node.required)) if (typeof name === 'string') required.add(name);
    }
    const out: Json = {};
    for (const key of unique([...declared, ...required])) {
      const isRequired = required.has(key);
      const located = FORBIDDEN_KEYS.has(key) ? undefined : valueSchemas(parts, key);
      if (!located) {
        if (isRequired) throw new MockError(`required property ${key} cannot be written: it is not allowed by additionalProperties: false, or it is an inherited name`);
        continue;
      }
      if (!isRequired && (depth >= this.ctx.maxDepth || (this.ctx.optional !== 'all' && !rng.child(`?${key}`).chance()))) continue;
      out[key] = this.sample(located, rng.child(key), depth + 1);
    }
    return out;
  }
}

function intersectTypes(a: string[], b: string[]): string[] {
  const out: string[] = [];
  for (const t of a) {
    if (b.includes(t)) out.push(t);
    else if ((t === 'number' && b.includes('integer')) || (t === 'integer' && b.includes('number'))) out.push('integer');
  }
  return unique(out);
}

// Ajv applies a keyword only to its own type; a node without `type` is sampled as the type its keywords describe.
function inferType(nodes: Json[]): string {
  const has = (keys: string[]) => nodes.some((n) => keys.some((k) => k in n));
  if (has(OBJECT_KEYS)) return 'object';
  if (has(ARRAY_KEYS)) return 'array';
  if (has(STRING_KEYS)) return 'string';
  return has(NUMBER_KEYS) ? 'number' : 'null';
}

/** The schemas a property's value must satisfy in every part, or undefined when a closed part does not allow it. */
function valueSchemas(parts: Part[], key: string): Located[] | undefined {
  const out: Located[] = [];
  for (const { node, base } of parts) {
    const properties = isObject(node.properties) ? node.properties : {};
    const patternProperties = isObject(node.patternProperties) ? node.patternProperties : {};
    const patterns = Object.keys(patternProperties).filter((p) => new RegExp(p, 'u').test(key));
    const declared = Object.hasOwn(properties, key);
    if (declared) out.push({ schema: properties[key], base });
    out.push(...patterns.map((p) => ({ schema: patternProperties[p], base })));
    if (declared || patterns.length > 0 || node.additionalProperties === undefined) continue;
    if (node.additionalProperties === false) return undefined;
    out.push({ schema: node.additionalProperties, base });
  }
  return out;
}

function patterned(pattern: string, rng: Rng, target: number, min: number): string {
  const node = parsePattern(pattern);
  if (!node) throw new MockError(`pattern ${pattern} is outside the sampled regex subset, and no example fits the node`);
  const value = samplePattern(node, rng, target);
  // An unanchored end still matches with text appended.
  return codePoints(value) < min && !endsAnchored(node) ? value + word(rng, min - codePoints(value)) : value;
}

function numberBounds(nodes: Json[]): [number, number] {
  const limit = (key: string, fallback: number) => nodes.map((n) => (typeof n[key] === 'number' ? n[key] : fallback));
  let lo = Math.max(...limit('minimum', -Infinity), ...limit('exclusiveMinimum', -Infinity));
  let hi = Math.min(...limit('maximum', Infinity), ...limit('exclusiveMaximum', Infinity));
  for (const node of nodes) {
    const range = typeof node.format === 'string' && Object.hasOwn(INT_RANGES, node.format) ? INT_RANGES[node.format] : undefined;
    if (range) [lo, hi] = [Math.max(lo, range[0]), Math.min(hi, range[1])];
  }
  // An open side gets a range of 1000 next to the other one, or [0, 1000].
  if (lo === -Infinity) lo = hi === Infinity ? 0 : hi - 1000;
  if (hi === Infinity) hi = lo + 1000;
  return [lo, hi];
}

function numberCandidate(lo: number, hi: number, integer: boolean, step: number | undefined, rng: Rng): number {
  const between = (a: number, b: number) => {
    const span = b - a;
    return Number.isFinite(span) ? a + rng.next() * span : a / 2 + b / 2 + (rng.next() - 0.5) * (b / 2 - a / 2);
  };
  if (step !== undefined) {
    const k = Math.round(between(Math.ceil(lo / step), Math.floor(hi / step)));
    return Number((k * step).toPrecision(15));
  }
  if (integer) return Math.round(between(Math.ceil(lo), Math.floor(hi)));
  const value = between(lo, hi);
  const rounded = Math.round(value * 100) / 100;
  return Number.isFinite(rounded) ? rounded : value;
}

function sampleNumber(nodes: Json[], integer: boolean, rng: Rng): number {
  const [lo, hi] = numberBounds(nodes);
  const step = nodes.map((n) => n.multipleOf).find((m): m is number => typeof m === 'number' && m > 0);
  const formats = nodes.map((n) => (typeof n.format === 'string' ? numberFormatPredicate(n.format) : undefined)).filter((f) => f !== undefined);
  const fits = (v: number) => Number.isFinite(v) && (!integer || Number.isInteger(v)) && nodes.every((n) => fitsNode(v, n)) && formats.every((f) => f(v));
  for (let attempt = 0; attempt < RETRIES; attempt++) {
    const value = numberCandidate(lo, hi, integer, step, attempt === 0 ? rng : rng.child(`#${attempt}`));
    if (fits(value)) return value;
  }
  const fallback = [lo / 2 + hi / 2, lo, hi, Math.ceil(lo), Math.floor(hi), step !== undefined ? Math.ceil(lo / step) * step : lo].find(fits);
  if (fallback === undefined) throw new MockError(`no ${integer ? 'integer' : 'number'} between ${lo} and ${hi} satisfies every limit of the node`);
  return fallback;
}

function context(schemas: MockSchemas, options: MockOptions): Context {
  const maxDepth = options.maxDepth ?? 3;
  if (!Number.isInteger(maxDepth) || maxDepth < 0) throw new RangeError(`mock: maxDepth must be a non-negative integer, got ${maxDepth}`);
  return { schemas, optional: options.optional ?? 'some', maxDepth, formats: options.formats ?? {}, budget: 20000 };
}

function withOverrides(value: unknown, overrides: unknown): unknown {
  if (!isObject(value) || !isObject(overrides)) return value;
  for (const key of Object.keys(overrides)) if (!FORBIDDEN_KEYS.has(key)) value[key] = clone(overrides[key]);
  return value;
}

/**
 * A value of schema `name` that passes the server's validation of it, generated from `options.seed`. `overrides`
 * replace top-level properties of an object value. Throws `MockUnsupported` (`MOCK001`) when the schema uses something
 * the sampler cannot honour, and `MockError` when it finds no value for a schema it supports.
 */
export function mockFrom<T>(schemas: MockSchemas, name: string, overrides?: Partial<T>, options: MockOptions = {}): T {
  if (!Object.hasOwn(schemas, name)) throw new Error(`mockFrom: no schema named ${name}`);
  const issue = mockIssue(schemas, name);
  if (issue) throw new MockUnsupported(name, issue);
  const value = new Sampler(context(schemas, options)).sample([{ schema: schemas[name], base: name }], new Rng(options.seed ?? 1), 0);
  return withOverrides(value, overrides) as T;
}

/** {@link mockFrom} for a schema outside the table, such as a route's reply; `label` names it in errors. */
export function mockSchema(schemas: MockSchemas, schema: MockSchema, label: string, options: MockOptions = {}): unknown {
  const issue = schemaIssue(schemas, schema, label);
  if (issue) throw new MockUnsupported(label, issue);
  return new Sampler(context(schemas, options)).sample([{ schema, base: label }], new Rng(options.seed ?? 1), 0);
}
