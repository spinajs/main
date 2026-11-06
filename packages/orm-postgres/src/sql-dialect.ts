import type { SqlDialectProfile } from '@spinajs/orm';

/** pg with the pool's type parsers (`utcTypeParser`): int8 and numeric stay strings, timestamp and date are Dates. */
export const POSTGRES_SQL_DIALECT: SqlDialectProfile = {
  name: 'postgresql',
  grammar: 'PostgresQL',
  placeholders: 'dollar',
  families: { bigint: 'string', decimal: 'string', date: 'Date', datetime: 'Date', time: 'string', json: 'unknown' },
  count: 'string',
  sum: { integer: 'string', bigint: 'string', decimal: 'string', float: 'number' },
  avg: { integer: 'string', bigint: 'string', decimal: 'string', float: 'number' },
  predicates: 'boolean',
};
