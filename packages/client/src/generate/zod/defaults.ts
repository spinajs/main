import { objectKey, valueCode } from './print.js';
import { isJson, type Json, type SchemaGraph } from './refs.js';

const isObjectRoot = (schema: Json): boolean =>
  schema.type === 'object' || (Array.isArray(schema.type) && schema.type.includes('object')) || isJson(schema.properties) || Array.isArray(schema.allOf);

/**
 * The `default` of each root property, for a form's initial values: `validation.useDefaults` fills the same ones on
 * an explicit `@Schema` (decision 16). Ajv applies `allOf` before `properties`, so a member's default wins.
 */
export function defaultsOf(schema: unknown, owner: string, graph: SchemaGraph, seen = new Set<string>()): Map<string, unknown> | undefined {
  if (!isJson(schema) || !isObjectRoot(schema)) return undefined;
  const found = new Map<string, unknown>();
  const members = Array.isArray(schema.allOf) ? schema.allOf : [];
  const own = Object.entries(isJson(schema.properties) ? schema.properties : {});
  const properties = own.flatMap(([name, p]): [string, unknown][] => (isJson(p) && 'default' in p ? [[name, p.default]] : []));
  for (const [name, value] of [...members.flatMap((m) => [...(memberDefaults(m, owner, graph, seen) ?? [])]), ...properties]) {
    if (!found.has(name)) found.set(name, value);
  }
  return found;
}

function memberDefaults(member: unknown, owner: string, graph: SchemaGraph, seen: Set<string>): Map<string, unknown> | undefined {
  const key = isJson(member) && typeof member.$ref === 'string' ? graph.resolve(member.$ref, owner) : undefined;
  if (key === undefined) return defaultsOf(member, owner, graph, seen);
  const entry = seen.has(key) ? undefined : graph.get(key);
  return entry && defaultsOf(entry.schema, entry.owner, graph, new Set([...seen, entry.key]));
}

export function defaultsLiteral(values: Map<string, unknown>): string {
  if (values.size === 0) return '{}';
  const members = [...values].map(([name, value]) => `  ${objectKey(name)}: ${valueCode(value)},`);
  return `{\n${members.join('\n')}\n}`;
}
