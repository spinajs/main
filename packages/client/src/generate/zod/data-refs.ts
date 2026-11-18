import { literal } from '../ts-type.js';
import { child, type Location } from './diagnostics.js';
import type { Check, ZodNode } from './print.js';
import { isJson, type Json } from './refs.js';

/** The keywords whose `{ $data }` value the emitter maps: `const` and the numeric and length limits. */
export const DATA_KEYWORDS = [
  'const', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minLength', 'maxLength', 'minItems', 'maxItems', 'minProperties', 'maxProperties',
];

const OPERATORS: Record<string, string> = {
  const: 'be equal to',
  minimum: 'be >=',
  maximum: 'be <=',
  exclusiveMinimum: 'be >',
  exclusiveMaximum: 'be <',
  multipleOf: 'be multiple of',
  minLength: 'NOT have fewer characters than',
  maxLength: 'NOT have more characters than',
  minItems: 'NOT have fewer items than',
  maxItems: 'NOT have more items than',
  minProperties: 'NOT have fewer properties than',
  maxProperties: 'NOT have more properties than',
};

export const isDataRef = (value: unknown): value is { $data: string } => isJson(value) && typeof value.$data === 'string' && Object.keys(value).length === 1;

/**
 * The path below the parent object of a relative JSON pointer `1/...`: the only form a check on that parent can read.
 * `0`, an index form (`1#`), a deeper climb and an absolute pointer reach data outside it.
 */
function parentPath(pointer: string): string[] | undefined {
  const match = /^1((?:\/[^/]*)*)$/.exec(pointer);
  return match ? match[1].split('/').slice(1).map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~')) : undefined;
}

/**
 * For a coerced object: what each `$data` check reads. Ajv validates the properties in order on one object, so a
 * keyword reads the siblings before its property as coerced and the ones after as sent: the check reads the object as
 * sent, with `before(name)` applied, and the property through `holder(name)`.
 */
export interface DataOrder {
  holder: (name: string) => string | undefined;
  before: (name: string) => { fn: string; uses: ZodNode[]; cut?: boolean } | undefined;
  /** Says (ZOD005) that the keyword at `at` is left unchecked. */
  unchecked: (at: Location) => void;
}

/** A location's key, to tell the builder which `$data` keywords a parent object has already checked. */
export const locationKey = (at: Location): string => `${at.schema}\u0000${at.pointer}`;

/**
 * `$data` in a property's own keywords (`DataValidator` builds Ajv with `$data: true`), as checks on the object that
 * holds it: there the referenced sibling is in reach. Adds the location of each keyword it maps to `handled`.
 */
export function dataChecks(properties: Json, at: Location, format: (name: string) => string, handled: Set<string>, order?: DataOrder): Check[] {
  return Object.entries(properties).flatMap(([name, schema]) => {
    if (!isJson(schema)) return [];
    return DATA_KEYWORDS.flatMap((keyword) => dataCheck(name, keyword, schema, at, format, handled, order));
  });
}

function dataCheck(name: string, keyword: (typeof DATA_KEYWORDS)[number], schema: Json, at: Location, format: (name: string) => string, handled: Set<string>, order?: DataOrder): Check[] {
  const value = schema[keyword];
  const path = isDataRef(value) ? parentPath(value.$data) : undefined;
  if (!isDataRef(value) || path === undefined) return [];
  handled.add(locationKey(child(at, 'properties', name, keyword)));
  const after = order?.before(name);
  // A replay that cannot be built (ZOD005) leaves the check off.
  if (after?.cut) {
    order?.unchecked(child(at, 'properties', name, keyword));
    return [];
  }
  const holder = `Reflect.get(o, ${literal(name)})`;
  const call = (held: string, source: string): string => `${format('dataLimit')}(${literal(keyword)}, ${held}, ${format('dataRef')}(${source}, ${JSON.stringify(path)}))`;
  const fn = order ? `((after, hold) => (o) => typeof o !== 'object' || o === null || ${call(`hold(${holder})`, 'after(o)')})(${after?.fn ?? '(o) => o'}, ${order.holder(name) ?? '(v) => v'})` : `(o) => ${call(holder, 'o')}`;
  return [{ kind: 'refine', fn, ...(after?.uses.length ? { uses: after.uses } : {}), message: `must ${OPERATORS[keyword]} ${value.$data}`, path: [name] }];
}
