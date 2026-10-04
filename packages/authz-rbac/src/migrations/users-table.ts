import { Configuration } from '@spinajs/configuration';
import { OrmDriver } from '@spinajs/orm';

/** The 2.x `users` table the role copy reads and the drop alters; shared by both migrations, not exported by the package. */
export const USERS_TABLE = 'users';
export const USER_ROLES_ROLE_COLUMN_KEY = 'authz.rbac.migration.roleColumn';
export const USER_ROLES_ID_COLUMN_KEY = 'authz.rbac.migration.idColumn';

/** The single source of these defaults; the config fragment does not repeat them. */
export const USER_ROLES_DEFAULT_ID_COLUMN = 'Uuid';
export const USER_ROLES_DEFAULT_ROLE_COLUMN = 'Role';

export interface UsersColumns {
  idColumn: string;
  roleColumn: string;
}

/**
 * The configured column names. Read through the connection's container, so it works both when the
 * migration service builds the migration and on a plain `new`.
 */
export async function configuredUsersColumns(connection: OrmDriver): Promise<UsersColumns> {
  const configuration = connection.Container.hasRegistered(Configuration) ? await connection.Container.resolve(Configuration) : undefined;
  return {
    idColumn: configuration?.get<string>(USER_ROLES_ID_COLUMN_KEY) ?? USER_ROLES_DEFAULT_ID_COLUMN,
    roleColumn: configuration?.get<string>(USER_ROLES_ROLE_COLUMN_KEY) ?? USER_ROLES_DEFAULT_ROLE_COLUMN,
  };
}

/**
 * The exact name, else the one column equal ignoring case: SQLite and MySQL treat column names
 * case-insensitively, and the name the table reports is the one that also works quoted on Postgres.
 */
export function matchColumn(names: readonly string[], wanted: string): string | undefined {
  if (names.includes(wanted)) return wanted;
  const folded = names.filter((n) => n.toLowerCase() === wanted.toLowerCase());
  return folded.length === 1 ? folded[0] : undefined;
}

/** The 2.x comma set: split on `,`, trimmed, empties dropped, deduplicated. */
export function splitRoles(value: unknown): string[] {
  return [
    ...new Set(
      String(value ?? '')
        .split(',')
        .map((r) => r.trim())
        .filter((r) => r !== ''),
    ),
  ];
}

/** Keyset page of `columns` ordered by the id column; `after` is the last id of the previous page. Rows with a NULL id are left out. */
export async function usersPage(connection: OrmDriver, idColumn: string, columns: string[], after: unknown, size: number): Promise<Record<string, unknown>[]> {
  const query = connection.select().columns(columns).from(USERS_TABLE).whereNotNull(idColumn).orderBy(idColumn).take(size);
  if (after !== undefined) query.where(idColumn, '>', after);
  return (await query) as Record<string, unknown>[];
}

export async function countNullIds(connection: OrmDriver, idColumn: string): Promise<number> {
  return Number(await connection.select().from(USERS_TABLE).whereNull(idColumn).selectCount());
}

export async function countUsers(connection: OrmDriver): Promise<number> {
  return Number(await connection.select().from(USERS_TABLE).selectCount());
}

export async function hasUsers(connection: OrmDriver): Promise<boolean> {
  return (await countUsers(connection)) > 0;
}

/** Inside the migration service's transaction when it runs one, else in our own. */
export function inTransaction(connection: OrmDriver, body: () => Promise<void>): Promise<void> {
  return connection.CurrentTransaction !== undefined ? body() : connection.transaction(body);
}

export function rowsAffected(result: unknown): number {
  return Number((result as { RowsAffected?: unknown } | undefined)?.RowsAffected ?? 0);
}
