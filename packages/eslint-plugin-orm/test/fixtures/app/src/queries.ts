import { sql } from '@spinajs/orm';
export const a = sql<{ Id: number; Email: string }>`SELECT Id, Email FROM users`;
export const b = sql<{ Id: number; Name: string | null }>`SELECT Id, Name FROM users WHERE Id = ${1}`;
export const c = sql<{ Name: string | null }>`SELECT Name FROM users`;
export const d = sql<{ Nmae: unknown }>`SELECT Nmae FROM users`;
export const e = sql<Record<string, unknown>>`SELECT Id + 1 FROM users`;
export const f = sql`SELECT Id FROM users WHERE ${sql.raw('1 = 1')}`;
export const g = sql`INSERT INTO users (Email) VALUES (${'a@b.c'})`;
export const h = sql`Id = ${1}`;
