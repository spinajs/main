import { Migration, OrmDriver, OrmMigration } from '@spinajs/orm';

/** Teams design §6. No ON DELETE CASCADE: rows go through model deletes, so authz-orm forgets their scopes. */
@Migration('default')
export class Teams_2026_10_14_00_00_00 extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    await connection.schema().createTable('teams', (table) => {
      table.string('id', 36).notNull().primaryKey();
      table.string('parent_id', 36);
      table.string('slug', 64).notNull().unique();
      table.string('name', 128).notNull();
      table.text('description');
      table.dateTime('archived_at');
      table.dateTime('deleted_at');
      table.string('created_by', 100);
      table.dateTime('created_at').notNull();
      table.dateTime('updated_at').notNull();
      table.foreignKey('parent_id').references('teams', 'id');
    });

    await connection.schema().createTable('groups', (table) => {
      table.string('id', 36).notNull().primaryKey();
      table.string('team_id', 36).notNull();
      table.string('parent_id', 36);
      table.string('slug', 64).notNull();
      table.string('name', 128).notNull();
      table.text('description');
      table.string('created_by', 100);
      table.dateTime('created_at').notNull();
      table.dateTime('updated_at').notNull();
      table.foreignKey('team_id').references('teams', 'id');
      table.foreignKey('parent_id').references('groups', 'id');
    });

    await connection.index().unique().table('groups').name('groups_team_slug').columns(['team_id', 'slug']);
    await connection.index().table('teams').name('teams_parent').columns(['parent_id']);
    await connection.index().table('groups').name('groups_parent').columns(['parent_id']);
  }

  public async down(connection: OrmDriver): Promise<void> {
    await connection.schema().dropTable('groups');
    await connection.schema().dropTable('teams');
  }
}
