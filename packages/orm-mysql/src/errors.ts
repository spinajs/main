import { ConstraintKind, ConstraintViolation, DataException, IConstraintViolationInfo, IDriverOptions, OrmException, UniqueViolation } from '@spinajs/orm';

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

type NativeError = { errno?: unknown; code?: unknown; message?: unknown; sqlState?: unknown } | null | undefined;

// a select that compares a datetime column with a value outside its range fails with it, under sqlState HY000
const ER_WRONG_VALUE = 1525;

/** Maps a mysql2 error by its errno: `1062` is a duplicate, the listed others a constraint failure; sqlState class 22 is a refused value. */
export function mapMySqlError(err: unknown, driver: Partial<IDriverOptions>, query: string, bindings: unknown): Error {
  const native = err as NativeError;
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

  return statementError(native, driver, query, bindings, err);
}

/** A refused value (sqlState class 22 or `ER_WRONG_VALUE`) is a DataException, any other error an OrmException. */
function statementError(native: NativeError, driver: Partial<IDriverOptions>, query: string, bindings: unknown, err: unknown): OrmException {
  const sqlState = typeof native?.sqlState === 'string' ? native.sqlState : '';
  const errno = native?.errno;
  if (sqlState.startsWith('22') || errno === ER_WRONG_VALUE) {
    return new DataException(`the database refused a value of the statement (errno ${String(errno)}, sqlState ${sqlState})`, driver, query, bindings, err);
  }

  return new OrmException('Error executing orm command ', driver, query, bindings, err);
}
