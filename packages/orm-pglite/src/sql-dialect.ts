import type { SqlDialectProfile } from '@spinajs/orm';

/** PGlite through its own result parsers (`pgCompatibleParsers`), which mirror the pg pool's. */
export const PGLITE_SQL_DIALECT: SqlDialectProfile = {
  name: 'pglite',
  grammar: 'PostgresQL',
  placeholders: 'dollar',
  families: { bigint: 'string', decimal: 'string', date: 'Date', datetime: 'Date', time: 'string', json: 'unknown' },
  count: 'string',
  sum: { integer: 'string', bigint: 'string', decimal: 'string', float: 'number' },
  avg: { integer: 'string', bigint: 'string', decimal: 'string', float: 'number' },
  predicates: 'boolean',
  nativeTypes: {
    int2: ['integer'], int4: ['integer'], int8: ['bigint'], numeric: ['decimal'], float4: ['float'], float8: ['float'],
    varchar: ['text', 'enum', 'uuid'], text: ['text', 'enum'], bpchar: ['text', 'uuid'], bool: ['boolean'], date: ['date'],
    timestamp: ['datetime'], timestamptz: ['datetime'], time: ['time'], json: ['json'], jsonb: ['json'], bytea: ['binary', 'uuid'], uuid: ['uuid'],
  },
};
