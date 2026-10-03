import { AuthzConfigError } from '@spinajs/authz';

import { idValue } from '../columns.js';
import type { ColumnInfo, Dialect, IdMode } from '../columns.js';
import { ONE, RUN, RUN_NO_SLASH, isLiteral, wellFormed } from './patterns.js';
import { FALSE, bind, num, sql } from './sql.js';
import type { Sql } from './sql.js';

const MAX = Number.MAX_SAFE_INTEGER;

/** `(CASE WHEN guard THEN expr ELSE NULL END)`: UNKNOWN where the evaluator cannot compare. */
export const caseWhen = (guard: Sql, expr: Sql): Sql => sql`(CASE WHEN ${guard} THEN ${expr} ELSE NULL END)`;

/** The SQL forms that differ between SQLite and Postgres (conventions §5). */
export interface SqlDialect {
  readonly name: Dialect;
  /** Two-valued: a non-null text value. */
  isText(c: Sql): Sql;
  /** Guard for comparing a string column; undefined when the column type alone guarantees text. */
  textGuard(c: Sql): Sql | undefined;
  /** Two-valued: a number the evaluator compares (finite, |v| <= 2^53-1). */
  isNumber(c: Sql): Sql;
  /** A bound string in the binary collation, for the right side of a comparison. */
  text(v: string): Sql;
  /** A bound string, for an IN list whose left side carries the collation. */
  textValue(v: string): Sql;
  /** The column in the binary collation, for the left side of IN and LIKE. */
  binary(c: Sql): Sql;
  number(v: number): Sql;
  /** Whether a row of this dialect can hold the string and the driver binds it unchanged. */
  canHold(s: string): boolean;
  /** Two-valued: the value the boolean converter hydrates; undefined when the column type has no exact form. */
  boolean(c: Sql, column: ColumnInfo): Sql | undefined;
  /** The whole leaf for a string column and a pattern; undefined when only UNKNOWN is sound. */
  match(c: Sql, tokens: readonly number[]): Sql | undefined;
  /** Two-valued: the column holds a value the adapter lists as an id (`idText` defined). */
  hasId(c: Sql, column: ColumnInfo, mode: IdMode): Sql;
  /** Two-valued: the adapter's `findRow` finds a row by this primary key value; undefined: never. */
  findable(c: Sql, column: ColumnInfo, mode: IdMode): Sql | undefined;
  /** Two-valued: `idText(mode, value) === id`. */
  idEq(c: Sql, column: ColumnInfo, mode: IdMode, id: string): Sql;
  /** The FROM item of a table, as the driver's own FROM clause names it. */
  table(quote: (name: string) => string, name: string, database: string | undefined): string;
}

const nativeType = (column: ColumnInfo): string => String(column.descriptor.NativeType ?? column.descriptor.Type ?? '').toLowerCase();

const sqlite: SqlDialect = {
  name: 'sqlite',
  isText: (c) => sql`typeof(${c}) = 'text'`,
  textGuard: (c) => sql`typeof(${c}) = 'text'`,
  isNumber: (c) => sql`(typeof(${c}) IN ('integer', 'real') AND ${c} BETWEEN ${num(-MAX)} AND ${num(MAX)})`,
  text: (v) => sql`${bind(v)} COLLATE BINARY`,
  textValue: (v) => bind(v),
  binary: (c) => sql`${c} COLLATE BINARY`,
  number: (v) => bind(v),
  canHold: wellFormed,
  // Any affinity: an integer or real 1, or the text '1' (fromDB: 1, true or '1'); BINARY so that an
  // RTRIM or NOCASE column collation cannot match '1 '.
  boolean: (c) => sql`(${c} IS NOT NULL AND (${c} = 1 COLLATE BINARY OR ${c} = '1' COLLATE BINARY))`,
  match(c, tokens) {
    // GLOB reads text up to the first NUL, the evaluator reads all of it.
    if (tokens.includes(0)) return undefined;
    const guard = sql`(typeof(${c}) = 'text' AND instr(${c}, char(0)) = 0)`;
    const slash = tokens.indexOf(RUN_NO_SLASH);
    if (slash === -1) return caseWhen(guard, sql`${c} GLOB ${bind(globPattern(tokens))}`);
    // A run without '/' has no GLOB form, except as the last token after a literal prefix.
    if (slash !== tokens.length - 1 || !tokens.slice(0, -1).every(isLiteral)) return undefined;
    const prefix = globPattern(tokens.slice(0, -1));
    return caseWhen(guard, sql`(${c} GLOB ${bind(`${prefix}*`)} AND NOT ${c} GLOB ${bind(`${prefix}*/*`)})`);
  },
  hasId(c, _column, mode) {
    switch (mode) {
      case 'string':
        return sql`typeof(${c}) = 'text'`;
      case 'number':
        return this.isNumber(c);
      case 'text':
        return sql`${c} IS NOT NULL`;
      case 'none':
        return FALSE;
    }
  },
  findable(c, column, mode) {
    return mode === 'none' ? undefined : this.hasId(c, column, mode);
  },
  idEq(c, _column, mode, id) {
    switch (mode) {
      case 'string':
        return wellFormed(id) ? sql`(typeof(${c}) = 'text' AND ${c} = ${this.text(id)})` : FALSE;
      case 'number': {
        const n = idValue('number', id);
        return typeof n === 'number' ? sql`(${this.isNumber(c)} AND ${c} = ${bind(n)})` : FALSE;
      }
      case 'text':
        return wellFormed(id) ? sql`(${c} IS NOT NULL AND CAST(${c} AS TEXT) = ${this.text(id)})` : FALSE;
      case 'none':
        return FALSE;
    }
  },
  table: (quote, name, database) => (database ? `${quote(database)}.${quote(name)}` : quote(name)),
};

const PG_BOOL = new Set(['bool', 'boolean']);
const PG_INTEGRAL = new Set(['int2', 'int4', 'int8', 'smallint', 'integer', 'bigint', 'float8', 'double precision']);
const PG_TEXT = new Set(['text', 'varchar', 'character varying']);

const postgres: SqlDialect = {
  name: 'postgres',
  isText: (c) => sql`${c} IS NOT NULL`,
  textGuard: () => undefined,
  isNumber: (c) => sql`(${c} IS NOT NULL AND ${c} BETWEEN ${num(-MAX)} AND ${num(MAX)})`,
  // Typed so the parameter is never inferred as the column's type (an int, or `name` that truncates).
  text: (v) => sql`CAST(${bind(v)} AS text) COLLATE "C"`,
  textValue: (v) => sql`CAST(${bind(v)} AS text)`,
  binary: (c) => sql`${c} COLLATE "C"`,
  number: (v) => sql`CAST(${bind(v)} AS double precision)`,
  // A Postgres text value never contains NUL, and binding one is an error.
  canHold: (s) => wellFormed(s) && !s.includes('\u0000'),
  boolean(c, column) {
    const type = nativeType(column);
    if (PG_BOOL.has(type)) return sql`COALESCE(${c}, FALSE)`;
    if (PG_INTEGRAL.has(type)) return sql`(${c} IS NOT NULL AND ${c} = 1)`;
    if (PG_TEXT.has(type)) return sql`(${c} IS NOT NULL AND ${c} = '1' COLLATE "C")`;
    return undefined;
  },
  match(c, tokens) {
    if (!tokens.includes(RUN_NO_SLASH)) return sql`(${this.binary(c)} LIKE CAST(${bind(likePattern(tokens))} AS text) ESCAPE E'\\\\')`;
    return sql`(${this.binary(c)} ~ CAST(${bind(regexPattern(tokens))} AS text))`;
  },
  hasId(c, _column, mode) {
    switch (mode) {
      case 'string':
      case 'text':
        return sql`${c} IS NOT NULL`;
      case 'number':
        return this.isNumber(c);
      case 'none':
        return FALSE;
    }
  },
  findable(c, column, mode) {
    if (mode === 'none') return undefined;
    // findRow accepts only the numeric text forms of finite values.
    if (mode === 'text' && nativeType(column) === 'numeric') return sql`(${c} IS NOT NULL AND CAST(${c} AS text) NOT IN ('NaN', 'Infinity', '-Infinity'))`;
    return this.hasId(c, column, mode);
  },
  idEq(c, _column, mode, id) {
    switch (mode) {
      case 'string':
        return this.canHold(id) ? sql`(${c} IS NOT NULL AND ${c} = ${this.text(id)})` : FALSE;
      case 'number': {
        const n = idValue('number', id);
        return typeof n === 'number' ? sql`(${this.isNumber(c)} AND ${c} = ${this.number(n)})` : FALSE;
      }
      case 'text':
        return this.canHold(id) ? sql`(${c} IS NOT NULL AND CAST(${c} AS text) = ${this.text(id)})` : FALSE;
      case 'none':
        return FALSE;
    }
  },
  table: (quote, name) => quote(name),
};

/** The dialect of an ORM driver; any driver but SQLite's and Postgres's is a configuration error. */
export function dialectFor(driver: unknown): SqlDialect {
  const name = (driver as { Options?: { Driver?: unknown } } | undefined)?.Options?.Driver;
  if (name === 'orm-driver-sqlite') return sqlite;
  if (name === 'orm-driver-postgres') return postgres;
  throw new AuthzConfigError(`authz-orm: cannot compile a residual for driver ${JSON.stringify(name)}; authz-orm compiles for sqlite and postgres only`);
}

function globPattern(tokens: readonly number[]): string {
  let out = '';
  for (const t of tokens) {
    if (t === RUN) out += '*';
    else if (t === ONE) out += '?';
    else {
      const ch = String.fromCodePoint(t);
      out += ch === '*' || ch === '?' || ch === '[' ? `[${ch}]` : ch;
    }
  }
  return out;
}

function likePattern(tokens: readonly number[]): string {
  let out = '';
  for (const t of tokens) {
    if (t === RUN) out += '%';
    else if (t === ONE) out += '_';
    else {
      const ch = String.fromCodePoint(t);
      out += ch === '%' || ch === '_' || ch === '\\' ? `\\${ch}` : ch;
    }
  }
  return out;
}

// In a Postgres ARE a backslash before any non-alphanumeric character stands for that character.
function regexPattern(tokens: readonly number[]): string {
  let out = '^';
  for (const t of tokens) {
    if (t === RUN) out += '.*';
    else if (t === RUN_NO_SLASH) out += '[^/]*';
    else if (t === ONE) out += '.';
    else {
      const ch = String.fromCodePoint(t);
      out += t < 0x80 && !/[A-Za-z0-9]/.test(ch) ? `\\${ch}` : ch;
    }
  }
  return `${out}$`;
}
