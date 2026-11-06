import { filterObject, subtractFieldGlobs } from '../contracts/fields.js';

export interface RedactFieldSet {
  /** Globs of the fields a record keeps when it carries no row field set of its own. */
  readonly read: readonly string[];
  /** Subtracted from every read set, the record's own included. */
  readonly neverRead?: readonly string[];
}

/** The JSON Schema subset redact() reads: `x-spina-fields` on a node or on its properties marks a record. */
export interface RedactSchema {
  readonly properties?: Readonly<Record<string, RedactSchema>>;
  readonly items?: RedactSchema;
  readonly 'x-spina-fields'?: string;
}

const ROW_FIELDS = new WeakMap<object, readonly string[]>();

/** Gives `row` its own read globs, which redact() uses instead of the default set. */
export function attachRowFields<T extends object>(row: T, read: readonly string[]): T {
  ROW_FIELDS.set(row, Object.freeze([...read]));
  return row;
}

export function rowFieldsOf(row: unknown): readonly string[] | undefined {
  return row !== null && typeof row === 'object' ? ROW_FIELDS.get(row) : undefined;
}

const isRecord = (v: unknown): v is object => v !== null && typeof v === 'object' && !ArrayBuffer.isView(v) && !(v instanceof ArrayBuffer);

const marks = (s: RedactSchema): boolean => s['x-spina-fields'] !== undefined || Object.values(s.properties ?? {}).some((p) => p['x-spina-fields'] !== undefined);

const anyMark = (s: RedactSchema): boolean => marks(s) || Object.values(s.properties ?? {}).some(anyMark) || (s.items !== undefined && anyMark(s.items));

/**
 * The value as a caller may read it. Each record keeps the fields its attached row set allows (else
 * `fieldSet.read`), minus `neverRead`; nested objects and arrays follow the dotted globs. Without a
 * schema, or with one that marks nothing, the value is the record (a list: each element). With a schema,
 * the marked nodes are the records and the nodes above them an envelope: an envelope key the schema
 * does not describe is filtered as a field of the envelope record, so an unknown key never passes as is.
 * Primitives and binary values at a record position pass unchanged.
 */
export function redact(value: unknown, fieldSet: RedactFieldSet, schema?: RedactSchema): unknown {
  const neverRead = fieldSet.neverRead ?? [];
  const globs = new Map<readonly string[], readonly string[]>();
  const readOf = (record: unknown): readonly string[] => {
    const read = rowFieldsOf(record) ?? fieldSet.read;
    let out = globs.get(read);
    if (out === undefined) globs.set(read, (out = neverRead.length === 0 ? read : subtractFieldGlobs(read, neverRead)));
    return out;
  };
  const record = (v: unknown): unknown => (isRecord(v) ? filterObject(readOf(v), v) : v);
  const atRecord = (v: unknown): unknown => (Array.isArray(v) ? v.map(record) : record(v));

  const walk = (v: unknown, s: RedactSchema): unknown => {
    if (marks(s)) return atRecord(v);
    if (Array.isArray(v)) return s.items !== undefined ? v.map((e) => walk(e, s.items!)) : atRecord(v);
    if (!isRecord(v)) return v;
    if (s.properties === undefined) return atRecord(v);
    const out: Record<string, unknown> = {};
    const rest: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(v)) {
      if (key === '__proto__') continue;
      if (Object.hasOwn(s.properties, key)) out[key] = walk(child, s.properties[key]);
      else rest[key] = child;
    }
    return Object.assign(out, filterObject(readOf(v), rest));
  };

  return schema === undefined || !anyMark(schema) ? atRecord(value) : walk(value, schema);
}
