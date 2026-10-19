import type { OrmDriver, QueryContext } from '@spinajs/orm';

export interface SentStatement {
  readonly sql: string;
  readonly context: QueryContext;
}

/** The statements `fn` sends through `driver`, with their query context. */
export async function statementsOf<R>(driver: OrmDriver, fn: () => Promise<R>): Promise<{ result: R; statements: SentStatement[] }> {
  const target = driver as unknown as { executeOnDb(stmt: string, params: unknown[], context: QueryContext): Promise<unknown> };
  const original = target.executeOnDb;
  const statements: SentStatement[] = [];
  target.executeOnDb = function (stmt, params, context) {
    statements.push({ sql: stmt, context });
    return original.call(this, stmt, params, context);
  };
  try {
    return { result: await fn(), statements };
  } finally {
    target.executeOnDb = original;
  }
}
