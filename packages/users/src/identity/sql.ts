import { DI } from '@spinajs/di';
import { IdentifierQuoter, Orm, OrmDriver, RawQuery, SqlExpressions } from '@spinajs/orm';

import { NO_PASSWORD, USER_COMMON_METADATA, User } from '../models/User.js';

/** @internal */
export const USERS_TABLE = 'users';

/** @internal The states of `users.Password` that hold no password. */
export function isNoPassword(value: unknown): boolean {
  return value === null || value === undefined || value === '' || value === NO_PASSWORD;
}

/**
 * @internal A cli process resolves only its command, so nothing else may have booted the Orm and the models are bare. Not
 * `@Autoinject(Orm)` on the stores: an async dependency makes their `DI.resolve` a Promise, and callers use it unawaited.
 */
export async function usersOrmUp(): Promise<void> {
  await DI.resolve(Orm);
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

/** @internal */
export function quoted(driver: OrmDriver, column: string): string {
  return driver.Container.resolve(IdentifierQuoter).quote(column);
}

/** @internal A SQL condition with its bindings, to combine before it becomes a `RawQuery`. */
export interface Condition {
  readonly sql: string;
  readonly bindings: unknown[];
}

/** @internal `column = value` compared byte for byte, whatever the column collation (MySQL's and SQL Server's defaults ignore case). */
export function exactlyEquals(driver: OrmDriver, column: string, value: string): Condition {
  const f = driver.Container.resolve(SqlExpressions).equalsExactly(quoted(driver, column), { sql: '?', bindings: [value] });
  return { sql: f.sql, bindings: [...f.bindings] };
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

/** @internal Stamps `users.PasswordSetAt` forward only, so writes that arrive out of order never move it back. */
export async function recordPasswordSetAt(uuid: string, at: Date): Promise<void> {
  const driver = usersDriver();
  const setAt = quoted(driver, 'PasswordSetAt');
  await driver
    .update()
    .in(USERS_TABLE)
    .update({ PasswordSetAt: at })
    .where('Uuid', uuid)
    .where(raw({ sql: `(${setAt} IS NULL OR ${setAt} < ?)`, bindings: [at] }));
}

/** @internal The number of rows an update or delete reports. */
export function rowsAffected(result: unknown): number {
  return Number((result as { RowsAffected?: unknown } | undefined)?.RowsAffected ?? 0);
}
