import { AuthzConfigError } from '@spinajs/authz';
import type { OrmDriver } from '@spinajs/orm';

import type { RbacIdMode } from '../scope-path.js';
import { FALSE_SQL, collation, ident, intSql, rsql } from './sql.js';
import type { RbacSql } from './sql.js';

export type RbacDialectName = 'sqlite' | 'postgres';

/** A column read as an id of its mode, as authz-orm's adapter reads it (`idText`, `findRow`). */
export interface RbacIdSql {
  /** Two-valued: the value is an id of the mode (`idText` gives one). */
  readonly holds: RbacSql;
  /**
   * Two-valued: an id whose text the SQL writes exactly as `idText` does. Narrower than `holds` for a
   * number that is not an integer, which SQL prints unlike JavaScript.
   */
  readonly exact: RbacSql;
  /** The id's text where `exact`, else NULL. */
  readonly text: RbacSql;
  /** Two-valued: as the primary key, `findRow` finds the row by this value. */
  readonly findable: RbacSql;
}

/** The SQL forms of the rule blocks that differ between dialects. Only SQLite and Postgres are compiled and tested. */
export interface RbacSqlDialect {
  readonly name: RbacDialectName;
  /** Whether `needle` occurs in `haystack`, case-sensitively; NULL when either is NULL. */
  contains(haystack: RbacSql, needle: RbacSql): RbacSql;
  /** The exact number a JSON number text denotes, as an SQL number. */
  number(jsonNumber: RbacSql): RbacSql;
  /** Ends a derived SELECT the planner must not merge into the outer query, so its columns are worked out once. */
  readonly fence: RbacSql;
  /** `column` read as an id of `mode`. */
  idOf(column: RbacSql, mode: Exclude<RbacIdMode, 'none'>): RbacIdSql;
  /** `a = b` in the binary collation, whatever the columns declare; NULL when either is NULL. */
  sameText(a: RbacSql, b: RbacSql): RbacSql;
  /** `a < b` by code points (the binary collation); NULL when either is NULL. */
  textBefore(a: RbacSql, b: RbacSql): RbacSql;
  /** Two-valued for a non-NULL text: it holds no character outside the Basic Multilingual Plane. */
  bmpOnly(text: RbacSql): RbacSql;
  /** The JSON text `doc` holds a string at `keys` (object keys from the top): that string; else NULL. */
  jsonString(doc: RbacSql, keys: readonly string[]): RbacSql;
  /** Two-valued for a JSON text `doc`: `keys` name a value, JSON null included. */
  jsonHas(doc: RbacSql, keys: readonly string[]): RbacSql;
  /** Two-valued for a JSON text `doc`: `keys` name JSON null. */
  jsonNull(doc: RbacSql, keys: readonly string[]): RbacSql;
  /** The text `doc` where the `json*` reads above may run on it (NULL elsewhere, which they read as nothing). */
  jsonDoc(doc: RbacSql): RbacSql;
  /**
   * Two-valued for a non-NULL text `doc`: JSON.parse refuses it or reads it otherwise than the `json*` reads do, or
   * the store's `rowToRule` cannot use it. Both dialects: the top level is not an object (rowToRule throws on null;
   * an array or a scalar it reads as an empty definition, refused here too, narrower), or `allow` or
   * `subjects.refs` is present and not an array (rowToRule throws on a truthy one; a falsy one is refused too,
   * narrower), or an entry of either is neither a principal ref (string `type` and `id`) nor `{ set: { role, scope } }`
   * with a non-empty string `role` and an object `scope` (`subjectToColumns` throws on an entry that is no object, a
   * `set` that is no object or has no such role, a missing scope; the other shapes are refused too, narrower).
   * SQLite: a NUL anywhere (json_valid reads up to it, JSON.parse refuses it), not RFC 8259 JSON
   * (one-argument `json_valid` refuses the JSON5 the other json functions accept from 3.42), a key repeated in one
   * object (json_extract takes the first, JSON.parse the last), or a `\u` escape anywhere (json_extract does not
   * find a key spelled with one; a value with one is refused too, narrower). Postgres: a text it cannot parse fails
   * the query, and `->` reads keys as JSON.parse does (escapes decoded, the last of repeated keys).
   */
  jsonUnlike(doc: RbacSql): RbacSql;
}

// The keys these blocks read are plain names: a path text needs no quoting.
const jsonPath = (keys: readonly string[]): string => {
  if (keys.length === 0 || keys.some((k) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(k))) throw new AuthzConfigError(`authz-rbac sql: ${JSON.stringify(keys)} is no path of plain JSON keys`);
  return `$.${keys.join('.')}`;
};

const ASTRAL = '\u{10000}-\u{10FFFF}';

const MAX = Number.MAX_SAFE_INTEGER;

const textId = (c: RbacSql): RbacIdSql => ({
  holds: rsql`(${c} IS NOT NULL)`,
  exact: rsql`(${c} IS NOT NULL)`,
  text: rsql`CAST(${c} AS TEXT)`,
  // findRow takes only the text forms of finite values, and a Postgres numeric can hold NaN and infinities.
  findable: rsql`(${c} IS NOT NULL AND CAST(${c} AS TEXT) NOT IN (${['NaN', 'Infinity', '-Infinity']}))`,
});

const sqlite: RbacSqlDialect = {
  name: 'sqlite',
  contains: (haystack, needle) => rsql`instr(${haystack}, ${needle}) > 0`,
  // NUMERIC affinity: an INTEGER when the text is one, else the REAL a JS number is.
  number: (json) => rsql`CAST(${json} AS NUMERIC)`,
  fence: rsql``,
  idOf(c, mode) {
    if (mode === 'text') return textId(c);
    if (mode === 'string') {
      const holds = rsql`(typeof(${c}) = ${'text'})`;
      return { holds, exact: holds, text: rsql`CASE WHEN ${holds} THEN ${c} END`, findable: holds };
    }
    const holds = rsql`(typeof(${c}) IN (${['integer', 'real']}) AND ${c} BETWEEN ${intSql(-MAX)} AND ${intSql(MAX)})`;
    // A real prints with a fraction ('5.0'); the integer cast of an integral one prints as JavaScript prints it.
    const exact = rsql`(${holds} AND ${c} = CAST(${c} AS INTEGER))`;
    return { holds, exact, text: rsql`CASE WHEN ${exact} THEN CAST(CAST(${c} AS INTEGER) AS TEXT) END`, findable: holds };
  },
  sameText: (a, b) => rsql`${a} = ${b} COLLATE BINARY`,
  textBefore: (a, b) => rsql`${a} < ${b} COLLATE BINARY`,
  // GLOB ranges compare code points.
  bmpOnly: (text) => rsql`NOT (${text} GLOB ${`*[${ASTRAL}]*`})`,
  jsonString: (doc, keys) => rsql`CASE WHEN json_type(${doc}, ${jsonPath(keys)}) = ${'text'} THEN json_extract(${doc}, ${jsonPath(keys)}) END`,
  jsonHas: (doc, keys) => rsql`(json_type(${doc}, ${jsonPath(keys)}) IS NOT NULL)`,
  jsonNull: (doc, keys) => rsql`(json_type(${doc}, ${jsonPath(keys)}) IS NOT NULL AND json_type(${doc}, ${jsonPath(keys)}) = ${'null'})`,
  jsonDoc: (doc) => rsql`CASE WHEN json_valid(${doc}) THEN ${doc} END`,
  jsonUnlike: (doc) => {
    const valid = rsql`CASE WHEN json_valid(${doc}) THEN ${doc} END`;
    const [a, b] = ['authz_jt', 'authz_ju'];
    const repeated = rsql`EXISTS (SELECT 1 FROM json_tree(${valid}) ${ident(a)}, json_tree(${valid}) ${ident(b)} WHERE ${ident(a, 'parent')} = ${ident(b, 'parent')} AND ${ident(a, 'key')} = ${ident(b, 'key')} AND ${ident(a, 'id')} < ${ident(b, 'id')})`;
    const notArray = (keys: readonly string[]) => rsql`(json_type(${valid}, ${jsonPath(keys)}) IS NOT NULL AND json_type(${valid}, ${jsonPath(keys)}) <> ${'array'})`;
    const e = 'authz_je';
    const v = ident(e, 'value');
    const type = (keys: readonly string[]) => rsql`json_type(${v}, ${jsonPath(keys)})`;
    // The CASE keeps json_type off an entry that is no object: json_each gives a text entry as the text, not as JSON.
    const unlikeEntry = rsql`(CASE WHEN ${ident(e, 'type')} IS NOT ${'object'} THEN 1 WHEN ${type(['set'])} IS NULL THEN NOT (${type(['type'])} IS ${'text'} AND ${type(['id'])} IS ${'text'}) ELSE NOT (${type(['set'])} IS ${'object'} AND ${type(['set', 'role'])} IS ${'text'} AND json_extract(${v}, ${jsonPath(['set', 'role'])}) IS NOT ${''} AND ${type(['set', 'scope'])} IS ${'object'}) END = 1)`;
    const unlikeEntries = (keys: readonly string[]) => rsql`EXISTS (SELECT 1 FROM json_each(${valid}, ${jsonPath(keys)}) ${ident(e)} WHERE ${unlikeEntry})`;
    const shape = rsql`(json_type(${valid}) IS NOT NULL AND json_type(${valid}) <> ${'object'}) OR ${notArray(['allow'])} OR ${notArray(['subjects', 'refs'])} OR ${unlikeEntries(['allow'])} OR ${unlikeEntries(['subjects', 'refs'])}`;
    return rsql`(instr(${doc}, char(0)) > 0 OR NOT json_valid(${doc}) OR instr(${doc}, ${'\\u'}) > 0 OR ${repeated} OR ${shape})`;
  },
};

/** `CAST(doc AS JSON) -> k1 -> … -> kn`: the JSON value at `keys`, SQL NULL when they name none. */
function pgJson(doc: RbacSql, keys: readonly string[], lastAsText = false): RbacSql {
  return pgAt(rsql`CAST(${doc} AS JSON)`, keys, lastAsText);
}

/** `json -> k1 -> … -> kn` (`->>` last when `lastAsText`). */
function pgAt(json: RbacSql, keys: readonly string[], lastAsText = false): RbacSql {
  jsonPath(keys);
  let out = json;
  keys.forEach((k, i) => {
    out = lastAsText && i === keys.length - 1 ? rsql`${out} ->> CAST(${k} AS TEXT)` : rsql`${out} -> CAST(${k} AS TEXT)`;
  });
  return rsql`(${out})`;
}

const postgres: RbacSqlDialect = {
  name: 'postgres',
  contains: (haystack, needle) => rsql`strpos(${haystack}, ${needle}) > 0`,
  // Unbounded numeric reads the shortest decimal JSON.stringify writes, so distinct doubles stay distinct and keep their order.
  number: (json) => rsql`CAST(${json} AS NUMERIC)`,
  // Postgres pulls a plain sub-select up and copies its expressions to each use; OFFSET 0 keeps it apart.
  fence: rsql` OFFSET 0`,
  idOf(c, mode) {
    if (mode === 'text') return textId(c);
    if (mode === 'string') {
      const holds = rsql`(${c} IS NOT NULL)`;
      return { holds, exact: holds, text: rsql`CAST(${c} AS TEXT)`, findable: holds };
    }
    const holds = rsql`(${c} IS NOT NULL AND ${c} BETWEEN ${intSql(-MAX)} AND ${intSql(MAX)})`;
    // A CASE: Postgres may evaluate an AND's operands in any order, and the bigint cast of a large double fails.
    const exact = rsql`(CASE WHEN ${holds} THEN ${c} = CAST(CAST(${c} AS BIGINT) AS DOUBLE PRECISION) ELSE ${FALSE_SQL} END)`;
    return { holds, exact, text: rsql`CASE WHEN ${exact} THEN CAST(CAST(${c} AS BIGINT) AS TEXT) END`, findable: holds };
  },
  // The database's default collation is deterministic, so its = compares byte by byte as "C" does, also against a
  // column with a nondeterministic collation; unlike "C" it is the collation of the authz tables' indexes, so a
  // stored scope_id is looked up by key.
  sameText: (a, b) => rsql`${a} = ${b} COLLATE ${collation('default')}`,
  textBefore: (a, b) => rsql`${a} < ${b} COLLATE ${collation('C')}`,
  bmpOnly: (text) => rsql`NOT (${text} ~ ${`[${ASTRAL}]`})`,
  jsonString: (doc, keys) => rsql`CASE WHEN json_typeof(${pgJson(doc, keys)}) = ${'string'} THEN ${pgJson(doc, keys, true)} END`,
  jsonHas: (doc, keys) => rsql`(${pgJson(doc, keys)} IS NOT NULL)`,
  jsonNull: (doc, keys) => rsql`(${pgJson(doc, keys)} IS NOT NULL AND json_typeof(${pgJson(doc, keys)}) = ${'null'})`,
  jsonDoc: (doc) => doc,
  jsonUnlike: (doc) => {
    const notArray = (keys: readonly string[]) => rsql`(${pgJson(doc, keys)} IS NOT NULL AND json_typeof(${pgJson(doc, keys)}) <> ${'array'})`;
    const v = rsql`${ident('authz_je', 'v')}`;
    const type = (keys: readonly string[]) => rsql`json_typeof(${pgAt(v, keys)})`;
    const unlikeEntry = rsql`(CASE WHEN json_typeof(${v}) IS DISTINCT FROM ${'object'} THEN TRUE WHEN ${pgAt(v, ['set'])} IS NULL THEN NOT (${type(['type'])} IS NOT DISTINCT FROM ${'string'} AND ${type(['id'])} IS NOT DISTINCT FROM ${'string'}) ELSE NOT (${type(['set'])} IS NOT DISTINCT FROM ${'object'} AND ${type(['set', 'role'])} IS NOT DISTINCT FROM ${'string'} AND ${pgAt(v, ['set', 'role'], true)} IS DISTINCT FROM ${''} AND ${type(['set', 'scope'])} IS NOT DISTINCT FROM ${'object'}) END)`;
    // json_array_elements fails on a value that is no array: the CASE hands it NULL (no rows) instead.
    const unlikeEntries = (keys: readonly string[]) => rsql`EXISTS (SELECT 1 FROM json_array_elements(CASE WHEN json_typeof(${pgJson(doc, keys)}) = ${'array'} THEN ${pgJson(doc, keys)} END) ${ident('authz_je')}(${ident('v')}) WHERE ${unlikeEntry})`;
    return rsql`(json_typeof(CAST(${doc} AS JSON)) <> ${'object'} OR ${notArray(['allow'])} OR ${notArray(['subjects', 'refs'])} OR ${unlikeEntries(['allow'])} OR ${unlikeEntries(['subjects', 'refs'])})`;
  },
};

/** By the connection's driver name, as authz-orm's `dialectFor`. */
export function rbacDialectOf(driver: OrmDriver): RbacSqlDialect {
  const name = (driver as { Options?: { Driver?: unknown } } | undefined)?.Options?.Driver;
  if (name === 'orm-driver-sqlite') return sqlite;
  if (name === 'orm-driver-postgres') return postgres;
  throw new AuthzConfigError(`authz-rbac sql: no rule blocks for driver ${JSON.stringify(name)}; SQLite and Postgres only until the other dialects are tested (plan task 8)`);
}
