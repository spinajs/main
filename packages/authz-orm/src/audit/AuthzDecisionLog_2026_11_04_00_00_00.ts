import { Migration, OrmMigration } from '@spinajs/orm';
import type { OrmDriver } from '@spinajs/orm';

import { DECISION_LOG_TABLE } from './decision-log-model.js';
import { AUDIT_CONNECTION } from './names.js';

/** Append-only: rows are inserted by DbDecisionLog and removed only by retention, which reads `at`. */
@Migration(AUDIT_CONNECTION)
export class AuthzDecisionLog_2026_11_04_00_00_00 extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    await connection.schema().createTable(DECISION_LOG_TABLE, (table) => {
      table.string('id', 36).primaryKey().notNull();
      table.dateTime('at').notNull();
      table.string('trace_id', 32);
      table.string('span_id', 16);
      table.string('domain', 64).notNull();
      table.string('principal', 100).notNull();
      table.string('actor', 100);
      table.string('permission', 160).notNull();
      table.string('resource', 255).notNull();
      table.boolean('allowed').notNull();
      table.string('reason', 255);
      table.boolean('cached').notNull();
      table.string('policy_hash', 128).notNull();
      table.text('model_versions');
      table.string('inputs_hash', 64).notNull();
      table.text('inputs');
    });

    await connection.index().table(DECISION_LOG_TABLE).name('authz_decision_log_at').columns(['at']);
    await connection.index().table(DECISION_LOG_TABLE).name('authz_decision_log_principal').columns(['principal', 'at']);
  }

  public async down(connection: OrmDriver): Promise<void> {
    await connection.schema().dropTable(DECISION_LOG_TABLE).ifExists();
  }
}
