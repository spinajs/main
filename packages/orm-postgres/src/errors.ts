import { ConstraintKind, ConstraintViolation, IDriverOptions, OrmException, UniqueViolation } from '@spinajs/orm';

const PG_CONSTRAINT_KINDS: Record<string, ConstraintKind> = {
  '23502': 'not_null',
  '23503': 'foreign_key',
  '23514': 'check',
};

const text = (value: unknown): string | undefined => (typeof value === 'string' && value.length > 0 ? value : undefined);

// `Key ("Email", tenant)=(a@x, 1) already exists.`
function keyColumns(detail: unknown): string[] | undefined {
  const key = typeof detail === 'string' ? /^Key \((.+?)\)=/.exec(detail) : null;
  return key ? key[1].split(',').map((c) => c.trim().replace(/^"(.*)"$/, '$1')) : undefined;
}

/** Maps a node-postgres error by its SQLSTATE: `23505` is a duplicate, the rest of class 23 another constraint. */
export function mapPostgresError(err: unknown, driver: Partial<IDriverOptions>, query: string, bindings: unknown): Error {
  const native = err as { code?: unknown; message?: unknown; table?: unknown; constraint?: unknown; column?: unknown; detail?: unknown } | null | undefined;
  const code = typeof native?.code === 'string' ? native.code : '';
  const message = String(native?.message ?? err);
  const info = { table: text(native?.table), constraint: text(native?.constraint) };

  if (code === '23505') {
    return new UniqueViolation(message, { ...info, columns: keyColumns(native?.detail) }, err);
  }

  if (code.startsWith('23')) {
    const column = text(native?.column);
    return new ConstraintViolation(message, PG_CONSTRAINT_KINDS[code] ?? 'other', { ...info, columns: column ? [column] : undefined }, driver, query, bindings, err);
  }

  return new OrmException('Error executing orm command ', driver, query, bindings, err);
}
