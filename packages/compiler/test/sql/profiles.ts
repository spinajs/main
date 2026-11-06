import type { SqlDialectProfile } from '@spinajs/manifest';

// Shaped like the driver profiles; the drivers own the real ones and test them against their databases.
export const PG: SqlDialectProfile = {
  name: 'postgresql', grammar: 'PostgresQL', placeholders: 'dollar',
  families: { bigint: 'string', decimal: 'string', date: 'Date', datetime: 'Date', time: 'string', json: 'unknown' },
  count: 'string', sum: { integer: 'string', bigint: 'string', decimal: 'string', float: 'number' }, avg: { integer: 'string', bigint: 'string', decimal: 'string', float: 'number' }, predicates: 'boolean',
};
export const MYSQL: SqlDialectProfile = {
  name: 'mysql', grammar: 'MySQL', placeholders: 'question',
  families: { boolean: 'number', bigint: 'number', decimal: 'string', date: 'Date', datetime: 'Date', time: 'string', json: 'unknown' },
  count: 'number', sum: { integer: 'string', bigint: 'string', decimal: 'string', float: 'number' }, avg: { integer: 'string', bigint: 'string', decimal: 'string', float: 'number' }, predicates: 'number',
};
export const SQLITE: SqlDialectProfile = {
  name: 'sqlite', grammar: 'Sqlite', placeholders: 'question',
  families: { boolean: 'number', bigint: 'number', decimal: 'number', date: 'string', datetime: 'string', time: 'string', json: 'string' },
  count: 'number', sum: { integer: 'number', bigint: 'number', decimal: 'number', float: 'number' }, avg: { integer: 'number', bigint: 'number', decimal: 'number', float: 'number' }, predicates: 'number',
};
export const MSSQL: SqlDialectProfile = {
  name: 'transactsql', grammar: 'TransactSQL', placeholders: 'at-p0',
  families: { bigint: 'string', decimal: 'number', date: 'unknown', datetime: 'unknown', time: 'unknown', json: 'string' },
  count: 'number', sum: { integer: 'number', bigint: 'string', decimal: 'number', float: 'number' }, avg: { integer: 'number', bigint: 'string', decimal: 'number', float: 'number' }, predicates: 'unknown',
};
