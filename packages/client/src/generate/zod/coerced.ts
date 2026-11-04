import type { ParamEntry } from '@spinajs/manifest';
import { isJson, type SchemaGraph } from './refs.js';

/** Argument kinds whose values arrive as strings: the server validates them with `coerceTypes: 'array'`, JSON-shaped ones too. */
export const COERCED_KINDS = new Set(['FromQuery', 'FromParams', 'FromHeader', 'FromCookie', 'QueryFieldRouteArgs', 'ParamFieldRouteArgs', 'HeadersFieldRouteArgs']);

// `DataValidator`'s default `validation.strict.idPrefixes`: schemas it validates without coercion.
const STRICT_ID_PREFIXES = ['authn.', 'authz.'];

export const isStrictId = (id: string): boolean => STRICT_ID_PREFIXES.some((prefix) => id.startsWith(prefix));

/**
 * The schemas a `<Name>Coerced` variant is declared for: those the coerced roots reach. A strict id is left out only as
 * a root, which DataValidator validates; nested in a derived argument, ManifestValidator coerces it with the rest.
 */
export function coercedClosure(graph: SchemaGraph, roots: Iterable<string>): Set<string> {
  const found = new Set<string>();
  const pending = [...roots];
  for (let key = pending.pop(); key !== undefined; key = pending.pop()) {
    if (found.has(key) || !graph.get(key)) continue;
    found.add(key);
    pending.push(...graph.targets(key));
  }
  return found;
}

/** How SpinaJS converts a scalar argument before validation, by its runtime type (`RouteArgs.fromRuntimeType`). */
export type ScalarRuntime = 'Number' | 'Boolean' | 'String' | 'BigInt';

export function scalarRuntime(param: ParamEntry): ScalarRuntime | undefined {
  const ref = param.runtimeType.ref;
  const name = ref?.package === 'global' ? ref.export : undefined;
  return name === 'Number' || name === 'Boolean' || name === 'String' || name === 'BigInt' ? name : undefined;
}

/** Whether the converted value is already of the schema's only type, so Ajv's coercion cannot change it. */
export function convertedFits(runtime: ScalarRuntime, schema: unknown): boolean {
  const type = isJson(schema) ? schema.type : undefined;
  return runtime === 'Number' ? type === 'number' || type === 'integer' : runtime === 'Boolean' && type === 'boolean';
}

const SAME_VALUE = ['not', 'if', 'then', 'else'] as const;
const ELEMENTS = ['items', 'additionalItems', 'contains'] as const;

/**
 * Whether the coerced schema at `key` can reach itself again without a step into the data: through an array that
 * wraps a scalar (the elements of a `type` that includes array), `$ref` and the combinators. `type T = number | T[]` is
 * one: a string that is no number is wrapped, and its element is wrapped again, with no end.
 */
export function wrapsWithoutEnd(graph: SchemaGraph, key: string): boolean {
  const seen = new Set<string>();
  const visit = (schema: unknown, owner: string, wrapped: boolean): boolean => {
    if (!isJson(schema)) return false;
    if (typeof schema.$ref === 'string') {
      const target = graph.resolve(schema.$ref, owner);
      if (target === key) return wrapped;
      const entry = target === undefined || seen.has(target) ? undefined : graph.get(target);
      if (entry) {
        seen.add(entry.key);
        if (visit(entry.schema, entry.owner, wrapped)) return true;
      }
    }
    const list = (k: string): unknown[] => (Array.isArray(schema[k]) ? (schema[k] as unknown[]) : []);
    const same = [...list('anyOf'), ...list('oneOf'), ...list('allOf'), ...SAME_VALUE.map((k) => schema[k])];
    if (same.some((member) => visit(member, owner, wrapped))) return true;
    const types: unknown[] = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.includes('array')) return false;
    return ELEMENTS.flatMap((k) => (Array.isArray(schema[k]) ? (schema[k] as unknown[]) : [schema[k]])).some((member) => visit(member, owner, true));
  };
  const entry = graph.get(key);
  return entry !== undefined && visit(entry.schema, entry.owner, false);
}
