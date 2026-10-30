import { compile } from 'json-schema-to-typescript';
import type { TypeContext } from './ts-type.js';

type Schema = Record<string, unknown>;

function isSchema(value: unknown): value is Schema {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Property names are data: a property called `title` or `$ref` must not be read as a keyword.
function prepareProperties(properties: Schema, ctx: TypeContext): Schema {
  return Object.fromEntries(Object.entries(properties).map(([name, schema]) => [name, prepare(schema, ctx)]));
}

// `tsType` is the json-schema-to-typescript escape hatch that replaces a node with a verbatim type expression.
function prepare(value: unknown, ctx: TypeContext): unknown {
  if (Array.isArray(value)) return (value as unknown[]).map((item) => prepare(item, ctx));
  if (!isSchema(value)) return value;
  if (typeof value.$ref === 'string') return { tsType: ctx.reference(value.$ref) };
  const out: Schema = {};
  for (const [key, item] of Object.entries(value)) {
    if (key.startsWith('x-') || key === '$id' || key === '$schema' || key === 'title') continue;
    out[key] = key === 'properties' && isSchema(item) ? prepareProperties(item, ctx) : prepare(item, ctx);
  }
  return out;
}

/** Emits one `export interface`/`export type` per named schema reachable from the types the client uses, ordered by type name. */
export async function emitDtoTypes(ctx: TypeContext): Promise<string> {
  const emitted = new Map<string, string>();
  const done = new Set<string>();
  for (;;) {
    const pending = [...ctx.used].filter((id) => !done.has(id)).sort();
    if (pending.length === 0) break;
    for (const id of pending) {
      done.add(id);
      const name = ctx.nameOf(id);
      const schema = prepare(ctx.schemaOf(id), ctx) as Schema;
      const code = await compile({ ...schema, title: name }, name, {
        bannerComment: '',
        declareExternallyReferenced: false,
        format: true,
        style: { singleQuote: true, printWidth: 120, endOfLine: 'lf' },
      });
      emitted.set(name, code.trim());
    }
  }
  return [...emitted.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, code]) => code)
    .join('\n\n');
}
