import type { SqlDialectProfile } from '@spinajs/orm';

/** sqlite3 returns INTEGER and REAL as numbers; `IsoDatetimeValueConverter` stores dates as ISO text. */
export const SQLITE_SQL_DIALECT: SqlDialectProfile = {
  name: 'sqlite',
  grammar: 'Sqlite',
  placeholders: 'question',
  families: { boolean: 'number', bigint: 'number', decimal: 'number', date: 'string', datetime: 'string', time: 'string', json: 'string' },
  count: 'number',
  sum: { integer: 'number', bigint: 'number', decimal: 'number', float: 'number' },
  avg: { integer: 'number', bigint: 'number', decimal: 'number', float: 'number' },
  predicates: 'number',
};
