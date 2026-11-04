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
