import type { SqlDialectProfile } from '@spinajs/orm';

export const PROFILE: SqlDialectProfile = { name: 'fixture', grammar: 'Sqlite', placeholders: 'question', families: { boolean: 'number' }, count: 'number', sum: {}, avg: {}, predicates: 'number' };
