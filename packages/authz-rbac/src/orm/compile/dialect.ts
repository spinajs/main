import { AuthzConfigError } from '@spinajs/authz';
import type { OrmDriver } from '@spinajs/orm';

import { rsql } from './sql.js';
import type { RbacSql } from './sql.js';

export type RbacDialectName = 'sqlite' | 'postgres';

/** The SQL forms of the rule blocks that differ between dialects. Only SQLite and Postgres are compiled and tested. */
export interface RbacSqlDialect {
  readonly name: RbacDialectName;
  /** Whether `needle` occurs in `haystack`, case-sensitively; NULL when either is NULL. */
  contains(haystack: RbacSql, needle: RbacSql): RbacSql;
  /** The exact number a JSON number text denotes, as an SQL number. */
  number(jsonNumber: RbacSql): RbacSql;
  /** Ends a derived SELECT the planner must not merge into the outer query, so its columns are worked out once. */
  readonly fence: RbacSql;
}

const sqlite: RbacSqlDialect = {
  name: 'sqlite',
  contains: (haystack, needle) => rsql`instr(${haystack}, ${needle}) > 0`,
  // NUMERIC affinity: an INTEGER when the text is one, else the REAL a JS number is.
  number: (json) => rsql`CAST(${json} AS NUMERIC)`,
  fence: rsql``,
};

const postgres: RbacSqlDialect = {
  name: 'postgres',
  contains: (haystack, needle) => rsql`strpos(${haystack}, ${needle}) > 0`,
  // Unbounded numeric reads the shortest decimal JSON.stringify writes, so distinct doubles stay distinct and keep their order.
  number: (json) => rsql`CAST(${json} AS NUMERIC)`,
  // Postgres pulls a plain sub-select up and copies its expressions to each use; OFFSET 0 keeps it apart.
  fence: rsql` OFFSET 0`,
};

/** By the connection's driver name, as authz-orm's `dialectFor`. */
export function rbacDialectOf(driver: OrmDriver): RbacSqlDialect {
  const name = (driver as { Options?: { Driver?: unknown } } | undefined)?.Options?.Driver;
  if (name === 'orm-driver-sqlite') return sqlite;
  if (name === 'orm-driver-postgres') return postgres;
  throw new AuthzConfigError(`authz-rbac sql: no rule blocks for driver ${JSON.stringify(name)}; SQLite and Postgres only until the other dialects are tested (plan task 8)`);
}
