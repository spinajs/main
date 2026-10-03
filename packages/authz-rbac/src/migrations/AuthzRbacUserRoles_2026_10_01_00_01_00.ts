import { engineLog, GLOBAL } from '@spinajs/authz';
import type { HostLog } from '@spinajs/authz';
import { Migration, OrmDriver, OrmMigration } from '@spinajs/orm';
import { randomUUID } from 'node:crypto';

import { AUTHZ_ASSIGNMENT_TABLE } from '../stores/assignment-row.js';
import { scopeToColumns, subjectToColumns } from '../stores/columns.js';
import { bumpVersion } from '../stores/version.js';
import { configuredUsersColumns, countNullIds, hasUsers, inTransaction, matchColumn, rowsAffected, splitRoles, USER_ROLES_ID_COLUMN_KEY, USER_ROLES_ROLE_COLUMN_KEY, USERS_TABLE, usersPage } from './users-table.js';
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
 */
@Migration('default')
export class AuthzRbacUserRoles_2026_10_01_00_01_00 extends OrmMigration {
  protected log: HostLog = engineLog('authz-rbac');
  protected readonly pageSize: number = 500;
  /** 10 columns a row keep one insert under SQLite's 999 bound parameters. */
  protected readonly insertBatch: number = 50;

  public async up(connection: OrmDriver): Promise<void> {
    const configured = await configuredUsersColumns(connection);

    await inTransaction(connection, async () => {
      const columns = await this.usersColumns(connection, configured);
      if (!columns) return;

      const { idColumn, roleColumn } = columns;
      const createdAt = new Date();
      let inserted = 0;
      let skipped = 0;
      let after: unknown = undefined;

      for (;;) {
        const users = await this.page(connection, idColumn, roleColumn, after);
        const rows: Record<string, unknown>[] = [];

        for (const user of users) {
          // the subject keeps the stored id as is: a trimmed id would not match the principal's
          const id = String(user[idColumn]);
          if (id.trim() === '') skipped++;
          else rows.push(...this.assignmentsOf(id, user[roleColumn], createdAt));
        }

        inserted += await this.insert(connection, rows);

        if (users.length < this.pageSize) break;
        after = users[users.length - 1][idColumn];
      }

      skipped += await countNullIds(connection, idColumn);
      if (skipped > 0) {
        this.log.warn(`${NAME}: skipped ${skipped} ${USERS_TABLE} row(s) whose ${idColumn} is null or empty; their roles were not copied`);
      }

      if (inserted > 0) await bumpVersion(connection, ROOT_DOMAIN);
    });
  }

  /**
   * Deletes only the copied rows. In a rollback the drop migration's `down()` runs first and
   * rebuilds the column from every `$global` user assignment, so nothing else needs undoing here.
   */
  public async down(connection: OrmDriver): Promise<void> {
    await inTransaction(connection, async () => {
      const result = await connection.del().from(AUTHZ_ASSIGNMENT_TABLE).where('source', USER_ROLES_SOURCE);
      if (rowsAffected(result) > 0) await bumpVersion(connection, ROOT_DOMAIN);
    });
  }

  /** Keyset page of `(id, role)` ordered by the id column; `after` is the last id of the previous page. */
  protected page(connection: OrmDriver, idColumn: string, roleColumn: string, after: unknown): Promise<Record<string, unknown>[]> {
    return usersPage(connection, idColumn, [idColumn, roleColumn], after, this.pageSize);
  }

  /**
   * The configured columns as the table spells them, or null when there is nothing to copy. A probe
   * that throws fails the migration: recording a copy that never ran as applied would lose the roles.
   */
  private async usersColumns(connection: OrmDriver, configured: UsersColumns): Promise<UsersColumns | null> {
    const info = await connection.tableInfo(USERS_TABLE);

    if (!info || info.length === 0) {
      this.log.info(`${NAME}: no table ${USERS_TABLE}; no roles copied`);
      return null;
    }

    const names = info.map((c) => c.Name);
    const idColumn = matchColumn(names, configured.idColumn);
    const roleColumn = matchColumn(names, configured.roleColumn);
    if (idColumn && roleColumn) return { idColumn, roleColumn };

    const missing = [
      [configured.idColumn, USER_ROLES_ID_COLUMN_KEY, idColumn],
      [configured.roleColumn, USER_ROLES_ROLE_COLUMN_KEY, roleColumn],
    ]
      .filter(([, , found]) => !found)
      .map(([column, key]) => `${column} (${key})`);
    const message = `${NAME}: table ${USERS_TABLE} has no column ${missing.join(', ')}; its columns are ${names.join(', ')}; no roles copied`;

    // an empty table loses nothing; a filled one is a misconfiguration the operator must see
    if (await hasUsers(connection)) this.log.warn(message);
    else this.log.info(message);

    return null;
  }

  private assignmentsOf(id: string, roles: unknown, createdAt: Date): Record<string, unknown>[] {
    const subject = subjectToColumns({ type: 'user', id });
    const scope = scopeToColumns(GLOBAL);

    return splitRoles(roles).map((role) => ({
      id: randomUUID(),
      ...subject,
      role,
      ...scope,
      tags: '',
      expires_at: null,
      granted_by: null,
      source: USER_ROLES_SOURCE,
      created_at: createdAt,
    }));
  }

  private async insert(connection: OrmDriver, rows: Record<string, unknown>[]): Promise<number> {
    let inserted = 0;

    for (let i = 0; i < rows.length; i += this.insertBatch) {
      const result = await connection
        .insert()
        .into(AUTHZ_ASSIGNMENT_TABLE)
        .values(rows.slice(i, i + this.insertBatch))
        .orIgnore();
      inserted += rowsAffected(result);
    }

    return inserted;
  }
}
