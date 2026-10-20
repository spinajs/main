import { ConstraintKind, ConstraintViolation, IConstraintViolationInfo, IDriverOptions, OrmException, UniqueViolation } from '@spinajs/orm';

const MYSQL_CONSTRAINT_KINDS: Record<number, ConstraintKind> = {
  1048: 'not_null',
  1364: 'not_null',
  1451: 'foreign_key',
  1452: 'foreign_key',
  3819: 'check',
};

// MySQL 8 names the key `table.key`, 5.7 the key alone
function duplicateKey(message: string): IConstraintViolationInfo {
  const key = /for key '([^']+)'/.exec(message)?.[1];
  if (!key) {
    return {};
  }

  const dot = key.lastIndexOf('.');
  return dot > 0 ? { table: key.slice(0, dot), constraint: key.slice(dot + 1) } : { constraint: key };
}

/** Maps a mysql2 error by its errno: `1062` is a duplicate, the listed others a constraint failure. */
export function mapMySqlError(err: unknown, driver: Partial<IDriverOptions>, query: string, bindings: unknown): Error {
  const native = err as { errno?: unknown; code?: unknown; message?: unknown } | null | undefined;
  const message = String(native?.message ?? err);

  if (native?.errno === 1062 || native?.code === 'ER_DUP_ENTRY') {
    return new UniqueViolation(message, duplicateKey(message), err);
  }

  const kind = typeof native?.errno === 'number' ? MYSQL_CONSTRAINT_KINDS[native.errno] : undefined;
  if (kind) {
    const column = /(?:Column|Field) '([^']+)'/.exec(message)?.[1];
    const constraint = /CONSTRAINT `([^`]+)`/.exec(message)?.[1] ?? /Check constraint '([^']+)'/.exec(message)?.[1];
    return new ConstraintViolation(message, kind, { constraint, columns: column ? [column] : undefined }, driver, query, bindings, err);
  }

  return new OrmException('Error executing orm command ', driver, query, bindings, err);
}
