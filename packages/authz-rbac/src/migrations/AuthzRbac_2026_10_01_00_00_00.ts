import { Migration, OrmDriver, OrmMigration } from '@spinajs/orm';

/**
 * The authz-rbac tables of design §9.1: assignments, the closure of subject sets, scoped check-only
 * rules with their subject lists, share links and the per-domain version counter.
 */
@Migration('default')
export class AuthzRbac_2026_10_01_00_00_00 extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    await connection.schema().createTable('authz_assignment', (table) => {
      table.string('id', 36).notNull().primaryKey();
      table.string('subject_type', 32).notNull();
      table.string('subject_id', 64).notNull();
      table.string('subject_role', 128).notNull().default().value('');
      // One portable key column: a row-value IN over (type, id, role) does not work on MSSQL or older SQLite.
      table.string('subject_key', 200).notNull();
      table.string('role', 128).notNull();
      table.string('scope_type', 64).notNull().default().value('$global');
      table.string('scope_id', 64).notNull().default().value('');
      table.string('tags', 512).notNull().default().value('');
      table.dateTime('expires_at');
      table.string('granted_by', 100);
      table.string('source', 32).notNull().default().value('db');
      table.dateTime('created_at').notNull();
    });

    await connection.index().unique().table('authz_assignment').name('authz_assignment_uq').columns(['subject_type', 'subject_id', 'subject_role', 'role', 'scope_type', 'scope_id']);
    await connection.index().table('authz_assignment').name('authz_assignment_scope').columns(['scope_type', 'scope_id', 'role']);
    await connection.index().table('authz_assignment').name('authz_assignment_expires').columns(['expires_at']);
    await connection.index().table('authz_assignment').name('authz_assignment_subject').columns(['subject_key', 'role']);

    await connection.schema().createTable('authz_subject_membership', (table) => {
      table.string('member_key', 200).notNull().primaryKey();
      table.string('set_key', 200).notNull().primaryKey();
      table.int('depth').notNull();
      table.dateTime('expires_at');
    });

    await connection.index().table('authz_subject_membership').name('authz_subject_membership_set').columns(['set_key']);

    await connection.schema().createTable('authz_rule', (table) => {
      table.string('id', 160).notNull().primaryKey();
      table.string('kind', 16).notNull();
      table.string('scope_type', 64).notNull().default().value('$global');
      table.string('scope_id', 64).notNull().default().value('');
      table.text('definition').notNull();
      table.dateTime('expires_at');
      table.string('created_by', 100);
      table.dateTime('created_at').notNull();
    });

    await connection.index().table('authz_rule').name('authz_rule_scope').columns(['scope_type', 'scope_id', 'kind']);

    await connection.schema().createTable('authz_rule_subject', (table) => {
      table.string('rule_id', 160).notNull().primaryKey();
      table.string('list', 8).notNull().primaryKey();
      table.string('subject_type', 32).notNull().primaryKey();
      table.string('subject_id', 64).notNull().primaryKey();
      table.string('subject_role', 128).notNull().default().value('').primaryKey();
    });

    await connection.schema().createTable('authz_link', (table) => {
      table.string('id', 36).notNull().primaryKey();
      table.string('token_hash', 128).notNull();
      table.string('scope_type', 64).notNull();
      table.string('scope_id', 64).notNull();
      table.text('attributes');
      table.dateTime('expires_at');
      table.dateTime('revoked_at');
      table.string('created_by', 100);
      table.dateTime('created_at').notNull();
    });

    await connection.index().unique().table('authz_link').name('authz_link_token').columns(['token_hash']);

    await connection.schema().createTable('authz_version', (table) => {
      table.string('domain', 64).notNull().primaryKey();
      table.bigint('version').notNull();
    });
  }

  public async down(connection: OrmDriver): Promise<void> {
    for (const table of ['authz_version', 'authz_link', 'authz_rule_subject', 'authz_rule', 'authz_subject_membership', 'authz_assignment']) {
      await connection.schema().dropTable(table);
    }
  }
}
