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
  // The sqlite compiler stores string, text, date, datetime, time and enum as TEXT, every integer as INTEGER, uuid as BLOB,
  // and gives json no type at all; a hand-written migration that stores JSON in a string column reads back as TEXT.
  nativeTypes: {
    integer: ['integer', 'bigint'], text: ['text', 'date', 'datetime', 'time', 'enum', 'json'], real: ['float'], decimal: ['decimal'],
    blob: ['binary', 'uuid'], boolean: ['boolean'], '': ['json'],
  },
  // CREATE TABLE renders every boolean NOT NULL.
  untrustedNullability: ['boolean'],
  caseInsensitiveIdentifiers: true,
  unboundedText: true,
  alterColumnRebuildsTable: true,
};
