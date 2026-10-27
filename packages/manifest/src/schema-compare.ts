import { canonicalize } from './hash.js';

type Schema = Record<string, unknown>;
type SchemaMap = Record<string, unknown>;

/** `request`: the client sends the value, `response`: the client reads it. Compatibility rules are mirrored. */
export type Direction = 'request' | 'response';

export interface Finding {
  breaking: boolean;
  detail: string;
}

interface Walk {
  direction: Direction;
  baseSchemas: SchemaMap;
  headSchemas: SchemaMap;
  seen: Set<string>;
  out: Finding[];
}

/** A resolved schema with `allOf` flattened and null-ability extracted; `lost` names a `$ref` that does not resolve. */
type Norm = { schema: Schema; nullable: boolean; lost?: undefined } | { lost: string };

const isSchema = (v: unknown): v is Schema => typeof v === 'object' && v !== null && !Array.isArray(v);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const props = (s: Schema): Schema => (isSchema(s.properties) ? s.properties : {});
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const isNullMember = (m: unknown): boolean => isSchema(m) && m.type === 'null';
const typeNames = (v: unknown): string[] | undefined => (typeof v === 'string' ? [v] : Array.isArray(v) ? strings(v) : undefined);

function mergeInto(target: Schema, part: Schema): void {
  target.properties = { ...props(part), ...props(target) };
  target.required = [...new Set([...strings(target.required), ...strings(part.required)])];
  for (const key of ['type', 'enum', 'items', 'anyOf', 'oneOf'] as const) target[key] ??= part[key];
  if (part.additionalProperties === false) target.additionalProperties = false;
}

/** Strips null from `type` and union members; returns the lone member left over from a `[X, null]` union. */
function extractNull(schema: Schema): { nullable: boolean; single?: unknown } {
  let nullable = false;
  let single: unknown;
  const types = typeNames(schema.type);
  if (types?.includes('null')) {
    nullable = true;
    schema.type = types.filter((t) => t !== 'null');
  }
  for (const key of ['anyOf', 'oneOf'] as const) {
    const all = list(schema[key]);
    if (!all.some(isNullMember)) continue;
    nullable = true;
    const rest = all.filter((m) => !isNullMember(m));
    if (rest.length === 1) {
      single = rest[0];
      delete schema[key];
    } else schema[key] = rest;
  }
  return { nullable, single };
}

function normalize(s: unknown, schemas: SchemaMap, depth = 0): Norm {
  if (!isSchema(s)) return { schema: {}, nullable: false };
  if (typeof s.$ref === 'string') {
    const next = schemas[s.$ref];
    return isSchema(next) && depth < 32 ? normalize(next, schemas, depth + 1) : { lost: s.$ref };
  }

  const schema: Schema = { ...s };
  delete schema.allOf;
  let nullable = s.nullable === true;
  for (const part of list(s.allOf)) {
    const n = normalize(part, schemas, depth + 1);
    if (n.lost !== undefined) return n;
    nullable ||= n.nullable;
    mergeInto(schema, n.schema);
  }
  const extracted = extractNull(schema);
  nullable ||= extracted.nullable;
  if (extracted.single === undefined) return { schema, nullable };

  const n = normalize(extracted.single, schemas, depth + 1);
  if (n.lost !== undefined) return n;
  mergeInto(schema, n.schema);
  return { schema, nullable: nullable || n.nullable };
}

function report(w: Walk, breaking: boolean, path: string, what: string): void {
  w.out.push({ breaking, detail: `${path} ${what}` });
}

function compareRequired(b: Schema, h: Schema, path: string, w: Walk): void {
  const before = strings(b.required);
  const after = strings(h.required);
  const stillThere = new Set(Object.keys(props(h)));

  for (const name of after.filter((n) => !before.includes(n))) {
    if (w.direction === 'request') report(w, true, `${path}.${name}`, 'is now required');
  }
  for (const name of before.filter((n) => !after.includes(n) && stillThere.has(n))) {
    report(w, w.direction === 'response', `${path}.${name}`, 'is no longer required');
  }
}

function compareProperties(b: Schema, h: Schema, path: string, w: Walk): void {
  const before = props(b);
  const after = props(h);

  for (const name of Object.keys(before)) {
    const next = after[name];
    if (next === undefined) report(w, w.direction === 'response', `${path}.${name}`, 'property removed');
    else walk(before[name], next, `${path}.${name}`, w);
  }
  for (const name of Object.keys(after).filter((n) => !(n in before))) report(w, false, `${path}.${name}`, 'property added');
}

function compareAdditional(b: Schema, h: Schema, path: string, w: Walk): void {
  const closedBefore = b.additionalProperties === false;
  const closedAfter = h.additionalProperties === false;
  if (closedBefore === closedAfter) return;
  report(w, closedAfter === (w.direction === 'request'), path, closedAfter ? 'additionalProperties now false' : 'additionalProperties no longer false');
}

function compareEnum(b: Schema, h: Schema, path: string, w: Walk): void {
  if (!Array.isArray(b.enum) || !Array.isArray(h.enum)) return;
  const request = w.direction === 'request';
  const [known, checked] = request ? [h.enum, b.enum] : [b.enum, h.enum];
  const keys = new Set(known.map((v) => canonicalize(v)));
  if (checked.some((v) => !keys.has(canonicalize(v)))) report(w, true, path, request ? 'enum value removed' : 'enum value added');
}

const memberKey = (m: unknown): string => (isSchema(m) && typeof m.$ref === 'string' ? `ref:${m.$ref}` : canonicalize(m));

const memberLabel = (m: unknown): string => (isSchema(m) && typeof m.$ref === 'string' ? (m.$ref.split('/').pop() ?? m.$ref) : 'inline');

function compareUnion(b: Schema, h: Schema, path: string, w: Walk): void {
  for (const key of ['anyOf', 'oneOf'] as const) {
    if (!Array.isArray(b[key]) || !Array.isArray(h[key])) continue;
    const before = new Map(b[key].map((m) => [memberKey(m), m]));
    const after = new Map(h[key].map((m) => [memberKey(m), m]));
    for (const [k, m] of before) {
      const next = after.get(k);
      if (next === undefined) report(w, w.direction === 'request', path, `${key} member removed`);
      else walk(m, next, `${path}|${memberLabel(m)}`, w);
    }
    for (const k of after.keys()) {
      if (!before.has(k)) report(w, w.direction === 'response', path, `${key} member added`);
    }
  }
}

const covers = (set: string[], t: string): boolean => set.includes(t) || (t === 'integer' && set.includes('number'));
const isSubset = (sub: string[] | undefined, sup: string[] | undefined): boolean => sup === undefined || (sub !== undefined && sub.every((t) => covers(sup, t)));
const hasUnion = (s: Schema): boolean => s.anyOf !== undefined || s.oneOf !== undefined;

/** Returns true when the types are incompatible, which stops the walk at this node. */
function compareType(b: Schema, h: Schema, path: string, w: Walk): boolean {
  const before = typeNames(b.type);
  const after = typeNames(h.type);
  // A union stands in for a missing type and is compared member by member.
  if ((before === undefined && hasUnion(b)) || (after === undefined && hasUnion(h))) return false;

  // What was accepted (request) or may now be emitted (response) must stay inside the other side.
  const compatible = w.direction === 'request' ? isSubset(before, after) : isSubset(after, before);
  if (compatible) return false;
  report(w, true, path, `type changed from ${canonicalize(b.type)} to ${canonicalize(h.type)}`);
  return true;
}

function compareNullable(b: boolean, h: boolean, path: string, w: Walk): void {
  if (b === h) return;
  report(w, h === (w.direction === 'response'), path, h ? 'now nullable' : 'no longer nullable');
}

function walk(base: unknown, head: unknown, path: string, w: Walk): void {
  if (!isSchema(base) || !isSchema(head)) return;

  if (base.$ref !== undefined || head.$ref !== undefined) {
    const pair = `${String(base.$ref)}|${String(head.$ref)}`;
    if (w.seen.has(pair)) return;
    w.seen.add(pair);
  }

  const b = normalize(base, w.baseSchemas);
  if (b.lost !== undefined) return;
  const h = normalize(head, w.headSchemas);
  if (h.lost !== undefined) {
    report(w, true, path, `$ref ${h.lost} no longer resolves`);
    return;
  }

  compareNullable(b.nullable, h.nullable, path, w);
  if (compareType(b.schema, h.schema, path, w)) return;

  compareProperties(b.schema, h.schema, path, w);
  compareRequired(b.schema, h.schema, path, w);
  compareAdditional(b.schema, h.schema, path, w);
  compareEnum(b.schema, h.schema, path, w);
  compareUnion(b.schema, h.schema, path, w);
  walk(b.schema.items, h.schema.items, `${path}[]`, w);
}

/**
 * Structural compatibility findings between two schema trees addressed by `$id`.
 *
 * Direction rule: a request change is breaking when it narrows what clients may send (enum value or union member
 * removed, type narrowed, nullable removed, property now required, additionalProperties closed). A response change is
 * breaking when it widens what clients may receive or drops what they rely on (enum value or union member added, type
 * widened, nullable added, property removed or no longer required, additionalProperties opened). The reverse is safe.
 */
export function compareSchemaRefs(baseId: string, headId: string, direction: Direction, baseSchemas: SchemaMap, headSchemas: SchemaMap, label: string): Finding[] {
  const w: Walk = { direction, baseSchemas, headSchemas, seen: new Set(), out: [] };
  walk({ $ref: baseId }, { $ref: headId }, label, w);
  return w.out;
}
