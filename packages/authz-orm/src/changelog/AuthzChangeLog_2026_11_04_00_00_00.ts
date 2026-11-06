import { AUTHZ_CONNECTION } from '@spinajs/authz';
import { Migration, OrmMigration } from '@spinajs/orm';
import type { OrmDriver } from '@spinajs/orm';

import { CHANGE_LOG_TABLE, CHANGE_LOG_WIDTHS, POLICY_VERSION_TABLE } from './table.js';

/**
 * authz_change_log (G15): append-only history of authz state, one row per change, written in the transaction of the
 * store write. authz_policy_version: the policy IR under each policy hash the app ran with. On the authz connection,
 * where the stores whose writes the log records live.
 */
@Migration(AUTHZ_CONNECTION)
export class AuthzChangeLog_2026_11_04_00_00_00 extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    await connection.schema().createTable(CHANGE_LOG_TABLE, (table) => {
      table.bigint('seq').primaryKey().autoIncrement();
      table.dateTime('at').notNull();
      table.string('kind', CHANGE_LOG_WIDTHS.kind).notNull();
      table.string('op', CHANGE_LOG_WIDTHS.op).notNull();
      table.string('key', CHANGE_LOG_WIDTHS.key).notNull();
      table.text('payload');
      table.string('actor', CHANGE_LOG_WIDTHS.actor);
      table.string('trace_id', CHANGE_LOG_WIDTHS.trace_id);
    });
    await connection.index().table(CHANGE_LOG_TABLE).name('authz_change_log_at').columns(['at']);
    await connection.index().table(CHANGE_LOG_TABLE).name('authz_change_log_key').columns(['kind', 'key']);

    await connection.schema().createTable(POLICY_VERSION_TABLE, (table) => {
      table.string('policy_hash', 64).notNull().primaryKey();
      table.text('ir').notNull();
      table.dateTime('first_seen_at').notNull();
    });
  }

  public async down(connection: OrmDriver): Promise<void> {
    await connection.schema().dropTable(POLICY_VERSION_TABLE).ifExists();
    await connection.schema().dropTable(CHANGE_LOG_TABLE).ifExists();
  }
}
