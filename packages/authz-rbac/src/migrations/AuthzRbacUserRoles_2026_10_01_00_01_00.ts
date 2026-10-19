import { AUTHZ_CONNECTION, engineLog, GLOBAL } from '@spinajs/authz';
import type { HostLog } from '@spinajs/authz';
import { findColumn, Migration, ormConnection, OrmDriver, OrmMigration } from '@spinajs/orm';
import { randomUUID } from 'node:crypto';

import { AUTHZ_ASSIGNMENT_TABLE } from '../stores/tables.js';
import { scopeToColumns, subjectKeyOf, subjectToColumns } from '../stores/columns.js';
import { bumpVersion } from '../stores/version.js';
import { configuredUsersColumns, countNullIds, hasUsers, inTransaction, splitRoles, subjectIdOf, USER_ROLES_ID_COLUMN_KEY, USER_ROLES_ROLE_COLUMN_KEY, USERS_CONNECTION, USERS_TABLE, usersPage } from './users-table.js';
import type { UsersColumns } from './users-table.js';

export { USER_ROLES_DEFAULT_ID_COLUMN, USER_ROLES_DEFAULT_ROLE_COLUMN, USER_ROLES_ID_COLUMN_KEY, USER_ROLES_ROLE_COLUMN_KEY } from './users-table.js';

/** `authz_assignment.source` of the rows copied from `users.<roleColumn>`. */
export const USER_ROLES_SOURCE = 'users.Role';

const ROOT_DOMAIN = 'root';
const NAME = 'AuthzRbacUserRoles_2026_10_01_00_01_00';

/**
 * Copies the 2.x `users.<roleColumn>` comma set into `$global` assignments of `user:<idColumn>`
 * (design §9.1, H8). The id column defaults to `Uuid`, the key of 3.0 user principals (§22).
 * Idempotent through `authz_assignment_uq`. Without a `users` table it is a no-op, so apps without
 * the users package migrate cleanly.
 *
 * It runs on the authz connection, so the assignments commit with its migration record, and reads
 * `users` on the connection the users package keeps it on.
 */
@Migration(AUTHZ_CONNECTION)
export class AuthzRbacUserRoles_2026_10_01_00_01_00 extends OrmMigration {
  protected log: HostLog = engineLog('authz-rbac');
  protected readonly pageSize: number = 500;

  public async up(connection: OrmDriver): Promise<void> {
    const users = ormConnection(USERS_CONNECTION);
    const configured = await configuredUsersColumns(users);

    await inTransaction(connection, async () => {
      const columns = await this.usersColumns(users, configured);
      if (!columns) return;

      await this.copy(users, connection, columns);
    });
  }

  /**
   * Deletes only the copied rows. In a rollback the drop migration's `down()` runs first and
   * rebuilds the column from every `$global` user assignment, so nothing else needs undoing here.
   */
  public async down(connection: OrmDriver): Promise<void> {
    await inTransaction(connection, async () => {
      const result = await connection.del().from(AUTHZ_ASSIGNMENT_TABLE).where('source', USER_ROLES_SOURCE);
      if (result.RowsAffected > 0) await bumpVersion({ driver: connection }, ROOT_DOMAIN, NAME);
    });
  }

  /** Keyset page of `(id, role)` of `users` ordered by the id column; `after` is the last id of the previous page. */
  protected page(connection: OrmDriver, idColumn: string, roleColumn: string, after: unknown): Promise<Record<string, unknown>[]> {
    return usersPage(connection, idColumn, [idColumn, roleColumn], after, this.pageSize);
  }

  private async copy(users: OrmDriver, authz: OrmDriver, { idColumn, roleColumn }: UsersColumns): Promise<void> {
    const createdAt = new Date();
    let inserted = 0;
    let skipped = 0;
    let after: unknown = undefined;

    for (;;) {
      const page = await this.page(users, idColumn, roleColumn, after);
      const rows: Record<string, unknown>[] = [];

      for (const user of page) {
        // the subject keeps the stored id as is: a trimmed id would not match the principal's
        const id = subjectIdOf(user[idColumn]);
        if (id.trim() === '') skipped++;
        else rows.push(...this.assignmentsOf(id, user[roleColumn], createdAt));
      }

      inserted += await this.insert(authz, rows);

      if (page.length < this.pageSize) break;
      after = page[page.length - 1][idColumn];
    }

    skipped += await countNullIds(users, idColumn);
    if (skipped > 0) {
      this.log.warn({ migration: NAME, skipped, table: USERS_TABLE, idColumn }, '${migration}: skipped ${skipped} ${table} row(s) whose ${idColumn} is null or empty; their roles were not copied');
    }

    if (inserted > 0) await bumpVersion({ driver: authz }, ROOT_DOMAIN, NAME);
  }

  /**
   * The configured columns as the table spells them, or null when there is nothing to copy. A probe
   * that throws fails the migration: recording a copy that never ran as applied would lose the roles.
   */
  private async usersColumns(users: OrmDriver, configured: UsersColumns): Promise<UsersColumns | null> {
    const info = await users.tableInfo(USERS_TABLE);

    if (!info || info.length === 0) {
      this.log.info({ migration: NAME, table: USERS_TABLE }, '${migration}: no table ${table}; no roles copied');
      return null;
    }

    const names = info.map((c) => c.Name);
    const idColumn = findColumn(info, configured.idColumn)?.Name;
    const roleColumn = findColumn(info, configured.roleColumn)?.Name;
    if (idColumn && roleColumn) return { idColumn, roleColumn };

    const missing = [
      [configured.idColumn, USER_ROLES_ID_COLUMN_KEY, idColumn],
      [configured.roleColumn, USER_ROLES_ROLE_COLUMN_KEY, roleColumn],
    ]
      .filter(([, , found]) => !found)
      .map(([column, key]) => `${column} (${key})`);
    const fields = { migration: NAME, table: USERS_TABLE, missing, columns: names };
    const template = '${migration}: table ${table} has no column ${missing}; its columns are ${columns}; no roles copied';

    // an empty table loses nothing; a filled one is a misconfiguration the operator must see
    if (await hasUsers(users)) this.log.warn(fields, template);
    else this.log.info(fields, template);

    return null;
  }

  private assignmentsOf(id: string, roles: unknown, createdAt: Date): Record<string, unknown>[] {
    const subject = subjectToColumns({ type: 'user', id });
    const scope = scopeToColumns(GLOBAL);

    return splitRoles(roles).map((role) => ({
      id: randomUUID(),
      ...subject,
      subject_key: subjectKeyOf({ type: 'user', id }),
      role,
      ...scope,
      tags: '',
      expires_at: null,
      granted_by: null,
      source: USER_ROLES_SOURCE,
      created_at: createdAt,
    }));
  }

  private async insert(authz: OrmDriver, rows: Record<string, unknown>[]): Promise<number> {
    if (rows.length === 0) return 0;
    const result = await authz.insert().into(AUTHZ_ASSIGNMENT_TABLE).values(rows).orIgnore();
    return result.RowsAffected;
  }
}
