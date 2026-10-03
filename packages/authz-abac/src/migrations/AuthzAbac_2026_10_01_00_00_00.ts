import { Migration, OrmDriver, OrmMigration } from '@spinajs/orm';

/**
 * `authz_policy` of design §9.1, plus `actor_types` and `priority`, which `Policy` gained in r2
 * and the table there lacks.
 */
@Migration('default')
export class AuthzAbac_2026_10_01_00_00_00 extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    await connection.schema().createTable('authz_policy', (table) => {
      table.string('id', 64).notNull().primaryKey();
      table.string('effect', 8).notNull();
      table.text('permissions').notNull();
      table.text('resource_types');
      table.text('principal_types');
      table.text('actor_types');
      table.string('scope_type', 64).notNull().default().value('$global');
      table.string('scope_id', 64).notNull().default().value('');
      table.text('condition');
      table.text('fields');
      table.string('reason', 64);
      table.int('priority');
      table.dateTime('expires_at');
      table.string('created_by', 100);
      table.dateTime('created_at').notNull();
    });

    await connection.index().table('authz_policy').name('authz_policy_scope').columns(['scope_type', 'scope_id']);
  }

  public async down(connection: OrmDriver): Promise<void> {
    await connection.schema().dropTable('authz_policy');
  }
}
