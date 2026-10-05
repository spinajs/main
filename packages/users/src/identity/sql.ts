import { IdentifierQuoter, OrmDriver, RawQuery } from '@spinajs/orm';
import { DateTime } from 'luxon';

import { NO_PASSWORD, USER_COMMON_METADATA, User } from '../models/User.js';

/** @internal */
export const USERS_TABLE = 'users';

/** @internal The states of `users.Password` that hold no password. */
export function isNoPassword(value: unknown): boolean {
  return value === null || value === undefined || value === '' || value === NO_PASSWORD;
}

/** @internal The users' connection: the one the base `User` model writes to. */
export function usersDriver(): OrmDriver {
  return User.query().Driver;
}

/** authn-local's `normalizeLogin`, which keys the login throttle. */
const normalized = (login: string) => login.normalize('NFKC').trim().toLowerCase();

/**
 * @internal Every user, soft-deleted ones included, whose Email or Login equals `login` as typed (trimmed) or, lower-cased
 * by the database, one of its folded forms. The typed match is what finds a non-ASCII capital on SQLite, whose `LOWER`
 * folds ASCII only. `LOWER()` keeps the unique indexes out, so this scans `users`.
 */
export async function usersMatchingLogin(login: string): Promise<User[]> {
  const typed = login.trim();
  const wanted = [...new Set([typed.toLowerCase(), normalized(login)])];
  const driver = usersDriver();
  const marks = wanted.map(() => '?').join(', ');
  const email = quoted(driver, 'Email');
  const name = quoted(driver, 'Login');

  return User.query()
    .withDeleted()
    .where(
      raw({
        sql: `(${email} = ? OR ${name} = ? OR LOWER(${email}) IN (${marks}) OR LOWER(${name}) IN (${marks}))`,
        bindings: [typed, typed, ...wanted, ...wanted],
      }),
    );
}

type Dialect = 'sqlite' | 'postgres' | 'mysql' | 'mssql' | 'other';

function dialectOf(driver: OrmDriver): Dialect {
  const registered = String(driver.Options?.Driver ?? '');
  for (const d of ['sqlite', 'postgres', 'mysql', 'mssql'] as const) {
    if (registered.includes(d)) {
      return d;
    }
  }
  return 'other';
}

/** @internal */
export function quoted(driver: OrmDriver, column: string): string {
  return driver.Container.resolve(IdentifierQuoter).quote(column);
}

/** @internal A SQL condition with its bindings, to combine before it becomes a `RawQuery`. */
export interface Condition {
  readonly sql: string;
  readonly bindings: unknown[];
}

/**
 * `column = value` compared byte for byte. The default collations of MySQL (utf8mb4_0900_ai_ci) and SQL Server
 * (SQL_Latin1_General_CP1_CI_AS) ignore case, and SQL Server also trailing spaces; SQLite and Postgres compare
 * exactly. An unknown driver gets a plain `=`.
 *
 * @internal
 */
export function exactlyEquals(driver: OrmDriver, column: string, value: string): Condition {
  const c = quoted(driver, column);
  switch (dialectOf(driver)) {
    case 'mysql':
      return { sql: `${c} = CAST(? AS BINARY)`, bindings: [value] };
    case 'mssql':
      return { sql: `(${c} = ? COLLATE Latin1_General_BIN2 AND LEN(${c} + 'x') = LEN(? + 'x'))`, bindings: [value, value] };
    default:
      return { sql: `${c} = ?`, bindings: [value] };
  }
}

/** @internal Exactly the stored values `isNoPassword` answers true for. */
export function holdsNoPassword(driver: OrmDriver, column: string): Condition {
  const empty = exactlyEquals(driver, column, '');
  const none = exactlyEquals(driver, column, NO_PASSWORD);
  return { sql: `(${quoted(driver, column)} IS NULL OR ${empty.sql} OR ${none.sql})`, bindings: [...empty.bindings, ...none.bindings] };
}

/** @internal A password, not a marker: neither a no-password state nor a value starting with '!' (authn-local's '!expired'). */
export function holdsPassword(driver: OrmDriver, column: string): Condition {
  const c = quoted(driver, column);
  return { sql: `(${c} IS NOT NULL AND ${c} <> ? AND ${c} NOT LIKE ?)`, bindings: ['', '!%'] };
}

/** @internal The `users` row carries `user:invite:pending` as a stored boolean true (the model reads only that as pending). */
export function invitePending(driver: OrmDriver): Condition {
  const q = (c: string) => quoted(driver, c);
  return {
    sql: `EXISTS (SELECT 1 FROM ${q('users_metadata')} WHERE ${q('user_id')} = ${q(USERS_TABLE)}.${q('Id')} AND ${q('Key')} = ? AND ${q('Type')} = ? AND ${q('Value')} = ?)`,
    bindings: [USER_COMMON_METADATA.USER_INVITE_PENDING, 'boolean', 'true'],
  };
}

/** @internal */
export function raw(condition: Condition): RawQuery {
  return RawQuery.create(condition.sql, condition.bindings);
}

/** @internal The text the ORM's datetime converter writes for a model's `@DateTime()` column, so model reads parse it back. */
export function sqlDateTime(at: Date): string {
  return DateTime.fromJSDate(at).toSQL({ includeOffset: false })!;
}

/** @internal The number of rows an update or delete reports. */
export function rowsAffected(result: unknown): number {
  return Number((result as { RowsAffected?: unknown } | undefined)?.RowsAffected ?? 0);
}
