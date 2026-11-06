import { sql } from '@spinajs/orm';

export const byEmail = sql<{ Id: number }>`SELECT Id FROM accounts WHERE Email = ${'a@b.c'}`;
export const wrong = sql`SELECT Id, Emial FROM accounts`;
