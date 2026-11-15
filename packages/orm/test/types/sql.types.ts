import { executeSql, sql, type SqlFragment } from '@spinajs/orm';

interface UserRow { Id: number; Email: string }

const typed = sql<UserRow>`SELECT Id, Email FROM users WHERE Id = ${1}`;

export const rows: Promise<UserRow[]> = executeSql(typed);
export const untyped: Promise<unknown[]> = executeSql(sql`SELECT 1`);
export const nested: SqlFragment = sql`SELECT Id FROM users WHERE ${sql`Id = ${1}`}`;
export const widened: SqlFragment = typed;
// @ts-expect-error the row is UserRow, not string
export const wrong: Promise<string[]> = executeSql(typed);
