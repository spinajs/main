import { Migration, OrmMigration } from '@spinajs/orm';
import type { OrmDriver } from '@spinajs/orm';

import { DECISION_LOG_TABLE } from './decision-log-model.js';
import { AUDIT_CONNECTION } from './names.js';

/** What a replay needs beside the record (L3): the principal facts, the logging instant and the decision's duration. Null on older rows. */
@Migration(AUDIT_CONNECTION)
export class AuthzDecisionLogFacts_2026_11_06_00_00_00 extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    await connection.schema().alterTable(DECISION_LOG_TABLE, (table) => {
      table.text('facts');
      table.dateTime('logged_at');
      table.int('duration_ms');
    });
  }

  public async down(connection: OrmDriver): Promise<void> {
    await connection.schema().alterTable(DECISION_LOG_TABLE, (table) => {
      table.dropColumn('facts');
      table.dropColumn('logged_at');
      table.dropColumn('duration_ms');
    });
  }
}
