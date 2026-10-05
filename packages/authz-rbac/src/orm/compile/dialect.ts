import { AuthzConfigError } from '@spinajs/authz';
import type { OrmDriver } from '@spinajs/orm';

import type { RbacIdMode } from '../scope-path.js';
import { FALSE_SQL, collation, intSql, rsql } from './sql.js';
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
}

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
};

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
  // "C" compares byte by byte, also against a column with a nondeterministic collation.
  sameText: (a, b) => rsql`${a} = ${b} COLLATE ${collation('C')}`,
};

/** By the connection's driver name, as authz-orm's `dialectFor`. */
export function rbacDialectOf(driver: OrmDriver): RbacSqlDialect {
  const name = (driver as { Options?: { Driver?: unknown } } | undefined)?.Options?.Driver;
  if (name === 'orm-driver-sqlite') return sqlite;
  if (name === 'orm-driver-postgres') return postgres;
  throw new AuthzConfigError(`authz-rbac sql: no rule blocks for driver ${JSON.stringify(name)}; SQLite and Postgres only until the other dialects are tested (plan task 8)`);
}
