import { engineLog, GLOBAL } from '@spinajs/authz';
import type { HostLog } from '@spinajs/authz';
import { IdentifierQuoter, Migration, OrmDriver, OrmMigration } from '@spinajs/orm';

import { AUTHZ_ASSIGNMENT_TABLE } from '../stores/assignment-row.js';
import { scopeToColumns } from '../stores/columns.js';
import { configuredUsersColumns, countUsers, hasUsers, inTransaction, matchColumn, splitRoles, USER_ROLES_ID_COLUMN_KEY, USER_ROLES_ROLE_COLUMN_KEY, USERS_TABLE, usersPage } from './users-table.js';

const NAME = 'AuthzRbacDropUserRole_2026_10_01_00_02_00';
const RESOLVE = `orm.Migration.resolve('${NAME}', 'rolled-back')`;

/**
 * Drops the 2.x `users.<roleColumn>` after `AuthzRbacUserRoles_2026_10_01_00_01_00` copied it
 * (design §9.2, H13). Refuses, changing nothing, while a users row holds a role that has no live
 * `$global` assignment of `user:<idColumn>`. `down()` re-adds the column and fills it from those
 * assignments, which is what a rollback to 2.x needs first. Roll back batch by batch (or with
 * `{ all: true }`) until this `down()` has run: `Migration.down(name)` acts only on the last
 * applied batch.
 */
@Migration('default')
export class AuthzRbacDropUserRole_2026_10_01_00_02_00 extends OrmMigration {
  protected log: HostLog = engineLog('authz-rbac');
  protected readonly pageSize: number = 500;
  /** How many missing pairs the refusal names. */
  protected readonly reported: number = 5;

  public async up(connection: OrmDriver): Promise<void> {
    const configured = await configuredUsersColumns(connection);

    await inTransaction(connection, async () => {
      const info = await connection.tableInfo(USERS_TABLE);
      if (!info || info.length === 0) {
        this.log.info(`${NAME}: no table ${USERS_TABLE}; nothing dropped`);
        return;
      }

      const names = info.map((c) => c.Name);
      const roleColumn = matchColumn(names, configured.roleColumn);
      const filled = await hasUsers(connection);

      if (!roleColumn) {
        const message = `${NAME}: table ${USERS_TABLE} has no column ${configured.roleColumn} (${USER_ROLES_ROLE_COLUMN_KEY}); its columns are ${names.join(', ')}; nothing dropped`;
        if (filled) this.log.warn(message);
        else this.log.info(message);
        return;
      }

      const q = connection.Container.resolve(IdentifierQuoter);

      // blocks writers of users (a 2.x instance still running) between the check and the drop; it
      // does not block authz_assignment writes. SQLite needs nothing, its single writer is this transaction
      if (connection.Options.Driver === 'orm-driver-postgres') {
        await connection.schema().raw(`LOCK TABLE ${q.quote(USERS_TABLE)} IN SHARE MODE`);
      }

      const idColumn = matchColumn(names, configured.idColumn);
      if (idColumn) {
        await this.assertCopied(connection, idColumn, roleColumn);
      } else if (filled) {
        throw new Error(`${NAME}: cannot check the ${USERS_TABLE}.${roleColumn} copy: table ${USERS_TABLE} has no column ${configured.idColumn} (${USER_ROLES_ID_COLUMN_KEY}); its columns are ${names.join(', ')}; nothing was changed`);
      }

      // the ORM's dropColumn() emits the name unquoted, which Postgres folds to lower case
      await connection.schema().raw(`ALTER TABLE ${q.quote(USERS_TABLE)} DROP COLUMN ${q.quote(roleColumn)}`);
    });
  }

  /**
   * Re-adds the column and fills it with each user's live `$global` roles, sorted and joined with
   * `,`. 2.x declared it NOT NULL without a default; the default `''` lets the existing rows exist.
   */
  public async down(connection: OrmDriver): Promise<void> {
    const configured = await configuredUsersColumns(connection);

    await inTransaction(connection, async () => {
      const info = await connection.tableInfo(USERS_TABLE);
      if (!info || info.length === 0) {
        this.log.info(`${NAME}: no table ${USERS_TABLE}; nothing re-added`);
        return;
      }

      const names = info.map((c) => c.Name);
      if (matchColumn(names, configured.roleColumn)) return;

      const roleColumn = configured.roleColumn;
      await connection.schema().alterTable(USERS_TABLE, (table) => {
        table.string(roleColumn, 256).notNull().default().value('');
      });

      const idColumn = matchColumn(names, configured.idColumn);
      if (!idColumn) {
        if (await hasUsers(connection)) {
          this.log.warn(`${NAME}: table ${USERS_TABLE} has no column ${configured.idColumn} (${USER_ROLES_ID_COLUMN_KEY}); ${roleColumn} re-added empty`);
        }
        return;
      }

      const at = new Date();
      let after: unknown = undefined;

      for (;;) {
        const users = await this.page(connection, idColumn, roleColumn, after);
        const roles = await this.liveGlobalRoles(
          connection,
          users.map((u) => String(u[idColumn])),
          at,
        );

        for (const user of users) {
          const granted = roles.get(String(user[idColumn]));
          if (!granted) continue;
          await connection
            .update()
            .in(USERS_TABLE)
            .update({ [roleColumn]: [...granted].sort().join(',') })
            .where(idColumn, user[idColumn]);
        }

        if (users.length < this.pageSize) break;
        after = users[users.length - 1][idColumn];
      }
    });
  }

  /** Keyset page of `(id, role)` ordered by the id column; `after` is the last id of the previous page. */
  protected page(connection: OrmDriver, idColumn: string, roleColumn: string, after: unknown): Promise<Record<string, unknown>[]> {
    return usersPage(connection, idColumn, [idColumn, roleColumn], after, this.pageSize);
  }

  /** Throws, before any change, when a users row holds a role without a live `$global` assignment. */
  private async assertCopied(connection: OrmDriver, idColumn: string, roleColumn: string): Promise<void> {
    const at = new Date();
    const missing: string[] = [];
    let count = 0;
    let visited = 0;
    let skipped = 0;
    let after: unknown = undefined;

    for (;;) {
      const users = await this.page(connection, idColumn, roleColumn, after);
      const ids = users.map((u) => String(u[idColumn])).filter((id) => id.trim() !== '');
      const granted = await this.liveGlobalRoles(connection, ids, at);
      visited += users.length;

      for (const user of users) {
        const id = String(user[idColumn]);
        if (id.trim() === '') {
          if (splitRoles(user[roleColumn]).length > 0) skipped++;
          continue;
        }

        for (const role of splitRoles(user[roleColumn])) {
          if (granted.get(id)?.has(role)) continue;
          count++;
          if (missing.length < this.reported) missing.push(`user:${id} ${role}`);
        }
      }

      if (users.length < this.pageSize) break;
      after = users[users.length - 1][idColumn];
    }

    const nullIdRoles = (await connection.select().columns([roleColumn]).from(USERS_TABLE).whereNull(idColumn)) as Record<string, unknown>[];
    visited += nullIdRoles.length;
    skipped += nullIdRoles.filter((u) => splitRoles(u[roleColumn]).length > 0).length;

    const total = await countUsers(connection);
    const unique = visited === total;
    const refused = !unique || count > 0;

    if (skipped > 0) {
      const lost = refused ? '' : ' and are lost with the dropped column';
      this.log.warn(`${NAME}: skipped ${skipped} ${USERS_TABLE} row(s) with roles whose ${idColumn} is null or empty; their roles were not copied${lost}`);
    }

    // a keyset walk over tied ids skips rows; the copy skipped the same ones, so their pairs look complete
    if (!unique) {
      throw new Error(`${NAME}: cannot check the ${USERS_TABLE}.${roleColumn} copy: the walk by ${USERS_TABLE}.${idColumn} read ${visited} of ${total} rows, so ${USERS_TABLE}.${idColumn} (${USER_ROLES_ID_COLUMN_KEY}) is not unique; nothing was changed. Point ${USER_ROLES_ID_COLUMN_KEY} at a unique column, then run ${RESOLVE} and migrate again`);
    }

    if (count > 0) {
      const more = count > missing.length ? ', …' : '';
      throw new Error(`${NAME}: the ${USERS_TABLE}.${roleColumn} copy is incomplete: ${count} user/role pair(s) have no live $global assignment (${missing.join(', ')}${more}); nothing was changed. Grant the missing roles through AuthzAdmin.assign or authz:assign (this also renews an expired grant), or remove them from ${USERS_TABLE}.${roleColumn} if they were revoked on purpose; if every user is listed, check ${USER_ROLES_ID_COLUMN_KEY} and ${USER_ROLES_ROLE_COLUMN_KEY}. Then run ${RESOLVE} and migrate again`);
    }
  }

  /** Roles per subject id from live `$global` principal assignments of `user:<id>`. */
  private async liveGlobalRoles(connection: OrmDriver, ids: string[], at: Date): Promise<Map<string, Set<string>>> {
    const roles = new Map<string, Set<string>>();
    if (ids.length === 0) return roles;

    const rows = (await connection
      .select()
      .columns(['subject_id', 'role'])
      .from(AUTHZ_ASSIGNMENT_TABLE)
      .where({ subject_type: 'user', subject_role: '', ...scopeToColumns(GLOBAL) })
      .whereIn('subject_id', ids)
      .where(function () {
        this.whereNull('expires_at').orWhere('expires_at', '>', at);
      })) as { subject_id: string; role: string }[];

    for (const row of rows) {
      const set = roles.get(row.subject_id) ?? new Set<string>();
      set.add(row.role);
      roles.set(row.subject_id, set);
    }

    return roles;
  }
}
