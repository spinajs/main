import { AuthzConfigError } from '@spinajs/authz';
import { BooleanValueConverter, extractModelDescriptor } from '@spinajs/orm';
import type { IColumnDescriptor, IModelDescriptor } from '@spinajs/orm';

/**
 * How a column's hydrated value compares, in memory and in SQL (conventions §5). The kind follows
 * what hydration really yields, so the in-memory evaluator and the compiled SQL see the same value:
 * - string: text/varchar columns, a string or null;
 * - number: integer and double columns, a finite number or null;
 * - boolean: a column with the boolean converter, whose fromDB maps NULL and anything but 1 to false;
 * - opaque: anything else without a converter (dates, json, PG numeric/int8 that hydrate as strings,
 *   float4 whose JS value differs from its SQL value): a marker or null, never comparable;
 * - converted: any other converter; the hydrated value tells nothing about the SQL value, not even
 *   whether it is NULL, so the marker stands for every row.
 */
export type ColumnKind = 'string' | 'number' | 'boolean' | 'opaque' | 'converted';

export type Dialect = 'sqlite' | 'postgres';

/** Stands for a value that compares with nothing: the evaluator reads a plain object as incomparable. */
export const OPAQUE: Readonly<Record<string, never>> = Object.freeze(Object.create(null));

export interface ColumnInfo {
  readonly name: string;
  readonly kind: ColumnKind;
  readonly descriptor: IColumnDescriptor;
}

// Not citext: its equality ignores case even under COLLATE "C".
const PG_STRING = new Set(['text', 'varchar', 'character varying', 'name']);
const PG_NUMBER = new Set(['int2', 'int4', 'float8', 'smallint', 'integer', 'double precision']);

export function dialectOf(descriptor: IModelDescriptor | null | undefined): Dialect {
  const driver = descriptor?.Driver as { Options?: { Driver?: unknown } } | undefined;
  const name = driver?.Options?.Driver;
  if (name === 'orm-driver-sqlite') return 'sqlite';
  if (name === 'orm-driver-postgres') return 'postgres';
  throw new AuthzConfigError(`authz-orm: model ${descriptor?.Name ?? '<unknown>'} uses driver ${JSON.stringify(name)}; authz-orm compiles residuals for sqlite and postgres only`);
}

// SQLite type affinity (https://sqlite.org/datatype3.html §3.1), restricted to declared types whose
// hydrated values are plain strings or numbers. A value of another storage class can still sit in
// such a column; the compiler guards on typeof() and the normalisation below on the JS type.
function sqliteKind(type: string): ColumnKind {
  const t = type.toUpperCase();
  if (t.includes('INT')) return 'number';
  if (t.includes('CHAR') || t.includes('CLOB') || t.includes('TEXT')) return 'string';
  if (t.includes('BLOB') || t === '') return 'opaque';
  if (t.includes('REAL') || t.includes('FLOA') || t.includes('DOUB')) return 'number';
  if (t.includes('NUMERIC') || t.includes('DECIMAL')) return 'number';
  return 'opaque';
}

function kindOf(column: IColumnDescriptor, dialect: Dialect): ColumnKind {
  if (column.Converter) return column.Converter instanceof BooleanValueConverter || isSqlBoolean(column.Converter) ? 'boolean' : 'converted';
  const type = String(column.NativeType ?? column.Type ?? '');
  if (dialect === 'postgres') {
    const t = type.toLowerCase();
    if (PG_STRING.has(t)) return 'string';
    if (PG_NUMBER.has(t)) return 'number';
    return 'opaque';
  }
  return sqliteKind(type);
}

// orm-sql's SqlBooleanValueConverter implements BooleanValueConverter without extending it.
const isSqlBoolean = (c: unknown): boolean => c !== null && typeof c === 'object' && (c.constructor as { name?: string })?.name === 'SqlBooleanValueConverter';

const cache = new WeakMap<object, ReadonlyMap<string, ColumnInfo>>();

/** Columns of a model by name. Read after the ORM loaded the table info (descriptor `Columns`). */
export function columnsOf(model: unknown): ReadonlyMap<string, ColumnInfo> {
  const descriptor = extractModelDescriptor(model as never);
  if (!descriptor) return new Map();
  const hit = cache.get(descriptor.Columns as object);
  if (hit) return hit;
  const dialect = dialectOf(descriptor);
  const out = new Map<string, ColumnInfo>();
  for (const c of descriptor.Columns ?? []) out.set(c.Name, Object.freeze({ name: c.Name, kind: kindOf(c, dialect), descriptor: c }));
  cache.set(descriptor.Columns as object, out);
  return out;
}

export function columnOf(model: unknown, field: string): ColumnInfo | undefined {
  return columnsOf(model).get(field);
}

/** The value the in-memory evaluator sees for a hydrated column value of this kind. */
export function normalize(kind: ColumnKind, value: unknown): unknown {
  switch (kind) {
    case 'string':
      return value === null || value === undefined ? null : typeof value === 'string' ? value : OPAQUE;
    case 'number':
      if (value === null || value === undefined) return null;
      return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER ? value : OPAQUE;
    case 'boolean':
      return value === true;
    case 'opaque':
      return value === null || value === undefined ? null : OPAQUE;
    case 'converted':
      return OPAQUE;
  }
}

/**
 * How a column takes part in id comparisons (`under`, `owner`, a row's own ref): the in-memory side
 * compares `idText(value)` with the id string, the SQL side follows the mode, and both agree.
 * - string: the text itself; number: a canonical number string; text: PG types whose hydrated value is
 *   exactly their text cast (uuid, int8, numeric); none: never equal to any id.
 */
export type IdMode = 'string' | 'number' | 'text' | 'none';

const PG_TEXT_IDS = new Set(['uuid', 'int8', 'bigint', 'numeric']);

export function idMode(column: ColumnInfo, dialect: Dialect): IdMode {
  if (column.kind === 'string' || column.kind === 'number') return column.kind;
  if (column.kind === 'opaque' && dialect === 'postgres' && PG_TEXT_IDS.has(String(column.descriptor.NativeType ?? '').toLowerCase())) return 'text';
  return 'none';
}

export function idText(mode: IdMode, value: unknown): string | undefined {
  switch (mode) {
    case 'string':
    case 'text':
      return typeof value === 'string' ? value : undefined;
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER ? String(value) : undefined;
    case 'none':
      return undefined;
  }
}

/** `Number(s)` when `s` is the canonical string of a finite number (the evaluator's coercion rule). */
export function numericString(s: string): number | undefined {
  const n = Number(s);
  return Number.isFinite(n) && String(n) === s ? n : undefined;
}

// The text forms PG prints for these types; any other id cannot equal a row's text and, bound as a
// parameter of the column's type, could be a cast error instead of a miss.
const PG_TEXT_FORMS: Readonly<Record<string, RegExp>> = {
  uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  int8: /^-?(0|[1-9][0-9]{0,18})$/,
  bigint: /^-?(0|[1-9][0-9]{0,18})$/,
  numeric: /^-?(0|[1-9][0-9]*)(\.[0-9]+)?$/,
};
const INT8 = { min: -(2n ** 63n), max: 2n ** 63n - 1n };

/** The DB value to look a row up by an id string, or undefined when no row of this column can have that id. */
export function idValue(mode: IdMode, id: string, column?: ColumnInfo): string | number | undefined {
  switch (mode) {
    case 'string':
      return id;
    case 'text': {
      const type = String(column?.descriptor.NativeType ?? '').toLowerCase();
      const form = PG_TEXT_FORMS[type];
      if (!form || !form.test(id)) return undefined;
      if ((type === 'int8' || type === 'bigint') && (BigInt(id) < INT8.min || BigInt(id) > INT8.max)) return undefined;
      return id;
    }
    case 'number': {
      const n = numericString(id);
      return n !== undefined && Math.abs(n) <= Number.MAX_SAFE_INTEGER ? n : undefined;
    }
    case 'none':
      return undefined;
  }
}
