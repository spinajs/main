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
  nativeTypes: {
    int: ['integer'], smallint: ['integer'], tinyint: ['integer'], bigint: ['bigint'], bit: ['boolean'], decimal: ['decimal'], numeric: ['decimal'],
    float: ['float'], real: ['float'], varchar: ['text', 'enum'], nvarchar: ['text', 'enum', 'json'], text: ['text'], ntext: ['text'],
    date: ['date'], datetime: ['datetime'], datetime2: ['datetime'], datetimeoffset: ['datetime'], time: ['time'],
    binary: ['binary', 'uuid'], varbinary: ['binary', 'uuid'], uniqueidentifier: ['uuid'],
  },
};
