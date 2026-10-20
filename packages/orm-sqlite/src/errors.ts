import { ConstraintKind, ConstraintViolation, IConstraintViolationInfo, IDriverOptions, OrmException, UniqueViolation } from '@spinajs/orm';

/**
 * node-sqlite3 reports every constraint failure as `SQLITE_CONSTRAINT` without the extended
 * result code, so the kind of constraint is read from the message.
 */
export function mapSqliteError(err: unknown, driver: Partial<IDriverOptions>, query: string, bindings: unknown): Error {
  const native = err as { code?: unknown; message?: unknown } | null | undefined;
  const message = String(native?.message ?? err);

  if (native?.code !== 'SQLITE_CONSTRAINT') {
    return new OrmException('Failed to execute query', driver, query, bindings, err);
  }

  const unique = /UNIQUE constraint failed: (.+)$/.exec(message);
  if (unique) {
    return new UniqueViolation(message, uniqueTarget(unique[1]), err);
  }

  if (/PRIMARY KEY must be unique/.test(message)) {
    return new UniqueViolation(message, {}, err);
  }

  const notNull = /NOT NULL constraint failed: ([^.\s]+)\.(\S+)/.exec(message);
  if (notNull) {
    return new ConstraintViolation(message, 'not_null', { table: notNull[1], columns: [notNull[2]] }, driver, query, bindings, err);
  }

  const check = /CHECK constraint failed: (.+)$/.exec(message);
  if (check) {
    return new ConstraintViolation(message, 'check', { constraint: check[1].trim() }, driver, query, bindings, err);
  }

  const kind: ConstraintKind = /FOREIGN KEY constraint failed/.test(message) ? 'foreign_key' : 'other';
  return new ConstraintViolation(message, kind, {}, driver, query, bindings, err);
}

// `t.a, t.b` for a column set, `index 'name'` for an index on expressions
function uniqueTarget(target: string): IConstraintViolationInfo {
  const index = /^index '(.+)'$/.exec(target.trim());
  if (index) {
    return { constraint: index[1] };
  }

  const qualified = target.split(',').map((c) => c.trim());
  const table = qualified[0].slice(0, Math.max(qualified[0].indexOf('.'), 0));

  return {
    table: table.length > 0 ? table : undefined,
    columns: qualified.map((c) => c.slice(c.indexOf('.') + 1)),
  };
}
