import type { SqlDialectProfile } from '@spinajs/orm';

/**
 * mysql2 with `decimalNumbers`, `supportBigNumbers` and `dateStrings` off (see `poolConfig`): DECIMAL, and SUM/AVG of
 * exact numbers, are strings. An app that turns one of them on through `Options` must declare its own profile.
 */
export const MYSQL_SQL_DIALECT: SqlDialectProfile = {
  name: 'mysql',
  grammar: 'MySQL',
  placeholders: 'question',
  families: { boolean: 'number', bigint: 'number', decimal: 'string', date: 'Date', datetime: 'Date', time: 'string', json: 'unknown' },
  count: 'number',
  sum: { integer: 'string', bigint: 'string', decimal: 'string', float: 'number' },
  avg: { integer: 'string', bigint: 'string', decimal: 'string', float: 'number' },
  predicates: 'number',
};
