import { executeSql, sql } from '@spinajs/orm';

const local = (strings: TemplateStringsArray): string => strings.join('');

export const all = sql`SELECT Id, Email FROM users`;
export const typed = sql<{ Id: number; Email: string | null }>`SELECT Id, Email FROM users WHERE Id = ${1}`;
export const nested = sql`SELECT Id FROM users WHERE ${sql`Id = ${2}`}`;
export const raw = sql`SELECT ${sql.raw('Id')} FROM users`;
export const list = sql`SELECT Id FROM users WHERE Id IN (${[1, 2]})`;
export const reports = (): Promise<unknown[]> => executeSql(sql`SELECT Id FROM posts`, { connection: 'reports' });
export const notOrm = local`SELECT nothing`;
