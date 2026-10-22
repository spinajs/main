import { ConstraintKind, ConstraintViolation, IDriverOptions, OrmException, UniqueViolation } from '@spinajs/orm';

type NativeError = { number?: unknown; message?: unknown; originalError?: { info?: { number?: unknown } } } | null | undefined;

/** Maps an mssql RequestError by its error number: `2627` / `2601` are duplicates, `515` / `547` other constraints. */
export function mapMsSqlError(err: unknown, driver: Partial<IDriverOptions>, query: string, bindings: unknown): Error {
  const native = err as NativeError;
  const number = errorNumberOf(native);
  const message = String(native?.message ?? err);
  const table = tableOf(message);

  if (number === 2627 || number === 2601) {
    const constraint = /constraint '([^']+)'/.exec(message)?.[1] ?? /unique index '([^']+)'/.exec(message)?.[1];
    return new UniqueViolation(message, { table, constraint }, err);
  }

  if (number === 515) {
    const column = /column '([^']+)'/.exec(message)?.[1];
    return new ConstraintViolation(message, 'not_null', { table, columns: column ? [column] : undefined }, driver, query, bindings, err);
  }

  if (number === 547) {
    const kind: ConstraintKind = /CHECK constraint/.test(message) ? 'check' : /FOREIGN KEY|REFERENCE constraint/.test(message) ? 'foreign_key' : 'other';
    return new ConstraintViolation(message, kind, { table, constraint: /constraint "([^"]+)"/.exec(message)?.[1] }, driver, query, bindings, err);
  }

  return new OrmException('Error executing orm command ', driver, query, bindings, err);
}

function tableOf(message: string): string | undefined {
  return /object '([^']+)'/.exec(message)?.[1] ?? /table '([^']+)'/.exec(message)?.[1] ?? /table "([^"]+)"/.exec(message)?.[1];
}

function errorNumberOf(native: NativeError): number {
  return Number(native?.number ?? native?.originalError?.info?.number);
}
