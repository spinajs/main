import type { SqlDialectProfile } from '@spinajs/orm';

/** tedious: BIGINT is a string, DECIMAL a number, AVG of an int column an int. Dates depend on the column type. */
export const MSSQL_SQL_DIALECT: SqlDialectProfile = {
  name: 'transactsql',
  grammar: 'TransactSQL',
  placeholders: 'at-p0',
  families: { bigint: 'string', decimal: 'number', date: 'unknown', datetime: 'unknown', time: 'unknown', json: 'string' },
  count: 'number',
  sum: { integer: 'number', bigint: 'string', decimal: 'number', float: 'number' },
  avg: { integer: 'number', bigint: 'string', decimal: 'number', float: 'number' },
  predicates: 'unknown',
};
