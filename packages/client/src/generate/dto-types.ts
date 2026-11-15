import { compile } from 'json-schema-to-typescript';
import type { TypeContext } from './ts-type.js';

type Schema = Record<string, unknown>;

/** Returns the type name a `$ref` prints as. */
export type ReferenceName = (id: string) => string;

function isSchema(value: unknown): value is Schema {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Property names are data: a property called `title` or `$ref` must not be read as a keyword.
function prepareProperties(properties: Schema, reference: ReferenceName, drop: ReadonlySet<string>): Schema {
  return Object.fromEntries(Object.entries(properties).map(([name, schema]) => [name, clientSchema(schema, reference, drop)]));
}

const NOTHING: ReadonlySet<string> = new Set();

/**
 * The schema as the client prints it: without `x-*` keys, `$id`, `$schema` and `title`, and each `$ref` replaced by
 * `{ tsType: name }`, the json-schema-to-typescript escape hatch for a verbatim type expression. `drop` removes more
 * keywords; property names are data and always stay.
 */
export function clientSchema(value: unknown, reference: ReferenceName, drop: ReadonlySet<string> = NOTHING): unknown {
  if (Array.isArray(value)) return (value as unknown[]).map((item) => clientSchema(item, reference, drop));
  if (!isSchema(value)) return value;
  if (typeof value.$ref === 'string') return { tsType: reference(value.$ref) };
  const out: Schema = {};
  for (const [key, item] of Object.entries(value)) {
    if (key.startsWith('x-') || key === '$id' || key === '$schema' || key === 'title' || drop.has(key)) continue;
    out[key] = key === 'properties' && isSchema(item) ? prepareProperties(item, reference, drop) : clientSchema(item, reference, drop);
  }
  return out;
}

// Walks with `clientSchema` so the set holds exactly the schemas `emitDtoTypes` will print.
export function resolveReferences(ctx: TypeContext): void {
  const done = new Set<string>();
  for (;;) {
    const pending = [...ctx.used].filter((id) => !done.has(id));
    if (pending.length === 0) return;
    for (const id of pending) {
      done.add(id);
      clientSchema(ctx.schemaOf(id), (ref) => ctx.reference(ref));
    }
  }
}

/** Emits one `export interface`/`export type` per schema in `ctx.used`, ordered by type name. */
export async function emitDtoTypes(ctx: TypeContext): Promise<string> {
  const emitted = new Map<string, string>();
  for (const id of [...ctx.used].sort()) {
    const name = ctx.nameOf(id);
    const schema = clientSchema(ctx.schemaOf(id), (ref) => ctx.reference(ref)) as Schema;
    const code = await compile({ ...schema, title: name }, name, {
      bannerComment: '',
      declareExternallyReferenced: false,
      format: true,
      style: { singleQuote: true, printWidth: 120, endOfLine: 'lf' },
    });
    emitted.set(name, code.trim());
  }
  return [...emitted.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, code]) => code)
    .join('\n\n');
}
