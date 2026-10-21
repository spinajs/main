import { AUTHZ_CONNECTION } from '@spinajs/authz';
import { Migration, OrmDriver, OrmMigration } from '@spinajs/orm';

/** `authz_rebac_tuple` (design §5.2): one row per tuple, keyed by the hash of its four parts. */
@Migration(AUTHZ_CONNECTION)
export class AuthzRebac_2026_10_21_00_00_00 extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    await connection.schema().createTable('authz_rebac_tuple', (table) => {
      table.string('tuple_key', 64).notNull().primaryKey();
      table.string('namespace', 64).notNull();
      table.string('object_id', 128).notNull();
      table.string('relation', 64).notNull();
      table.string('subject_key', 320).notNull();
      table.string('subject_type', 64).notNull();
      table.string('subject_id', 128).notNull();
      table.string('subject_relation', 64).notNull().default().value('');
      table.string('created_by', 100);
      table.dateTime('created_at').notNull();
    });

    await connection.index().table('authz_rebac_tuple').name('authz_rebac_tuple_object').columns(['namespace', 'object_id', 'relation']);
    await connection.index().table('authz_rebac_tuple').name('authz_rebac_tuple_subject').columns(['subject_key']);
  }

  public async down(connection: OrmDriver): Promise<void> {
    await connection.schema().dropTable('authz_rebac_tuple');
  }
}
