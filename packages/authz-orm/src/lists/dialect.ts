import { AuthzConfigError } from '@spinajs/authz';
import type { SqlRowContext } from '@spinajs/authz';
import { IdentifierQuoter } from '@spinajs/orm';
import type { OrmDriver } from '@spinajs/orm';

export type SqlDialect = SqlRowContext['dialect'];

const DRIVERS: Readonly<Record<string, SqlDialect>> = {
  'orm-driver-sqlite': 'sqlite',
  'orm-driver-postgres': 'postgres',
  'orm-driver-mysql': 'mysql',
  'orm-driver-mysql-ssh': 'mysql',
  'orm-driver-mssql': 'mssql',
};

export function dialectOf(driver: OrmDriver): SqlDialect {
  const name = driver?.Options?.Driver as unknown;
  const dialect = typeof name === 'string' ? DRIVERS[name] : undefined;
  if (dialect === undefined) throw new AuthzConfigError(`authz-orm: connection ${JSON.stringify(driver?.Options?.Name)} uses driver ${JSON.stringify(name)}; lists render for sqlite, postgres, mysql and mssql`);
  return dialect;
}

/** An id or owner value as text; 64 matches authz_resource_ancestor.resource_id. */
export function castText(dialect: SqlDialect, sql: string): string {
  switch (dialect) {
    case 'mysql':
      return `CAST(${sql} AS CHAR(64))`;
    case 'mssql':
      return `CAST(${sql} AS NVARCHAR(64))`;
    default:
      return `CAST(${sql} AS TEXT)`;
  }
}

export function quoterOf(driver: OrmDriver): (name: string) => string {
  const q = driver.Container.resolve(IdentifierQuoter) as IdentifierQuoter;
  return (name) => q.quote(name);
}
