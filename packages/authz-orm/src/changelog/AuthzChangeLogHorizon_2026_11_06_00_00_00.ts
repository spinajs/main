import { AUTHZ_CONNECTION } from '@spinajs/authz';
import { Migration, OrmMigration } from '@spinajs/orm';
import type { OrmDriver } from '@spinajs/orm';

import { CHANGE_LOG_TABLE, HORIZON_TABLE, HORIZON_WIDTHS } from './table.js';

/**
 * authz_change_log_horizon: since when every write of a kind (of a resource type, for `column`) is in the changelog,
 * as the app's boots recorded it; for `column`, with the fingerprint of the type's relation columns at that time. authz_change_log.before: the state a `put` replaced, when the store logs it.
 */
@Migration(AUTHZ_CONNECTION)
export class AuthzChangeLogHorizon_2026_11_06_00_00_00 extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    await connection.schema().createTable(HORIZON_TABLE, (table) => {
      table.string('kind', HORIZON_WIDTHS.kind).notNull().primaryKey();
      table.string('resource_type', HORIZON_WIDTHS.resource_type).notNull().primaryKey().default().value('');
      table.dateTime('since').notNull();
      table.string('fingerprint', HORIZON_WIDTHS.fingerprint);
    });
    await connection.schema().alterTable(CHANGE_LOG_TABLE, (table) => {
      table.text('before');
    });
  }

  public async down(connection: OrmDriver): Promise<void> {
    await connection.schema().alterTable(CHANGE_LOG_TABLE, (table) => {
      table.dropColumn('before');
    });
    await connection.schema().dropTable(HORIZON_TABLE).ifExists();
  }
}
