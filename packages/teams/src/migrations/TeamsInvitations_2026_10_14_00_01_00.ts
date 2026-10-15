import { Migration, OrmDriver, OrmMigration } from '@spinajs/orm';

/** Teams design §6, invitations. */
@Migration('default')
export class TeamsInvitations_2026_10_14_00_01_00 extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    await connection.schema().createTable('team_invitations', (table) => {
      table.string('id', 36).notNull().primaryKey();
      table.string('team_id', 36).notNull();
      table.string('group_id', 36);
      table.string('role', 128).notNull();
      table.string('email', 255);
      table.string('token_hash', 128).notNull().unique();
      table.int('max_uses');
      table.int('uses').notNull().default().value(0);
      table.dateTime('expires_at').notNull();
      table.dateTime('revoked_at');
      table.string('created_by', 100).notNull();
      table.dateTime('created_at').notNull();
      table.dateTime('last_sent_at');
      table.foreignKey('team_id').references('teams', 'id');
      table.foreignKey('group_id').references('groups', 'id');
    });

    await connection.schema().createTable('team_invitation_uses', (table) => {
      table.string('invitation_id', 36).notNull();
      table.string('principal', 200).notNull();
      table.dateTime('used_at').notNull();
      table.foreignKey('invitation_id').references('team_invitations', 'id');
    });

    // The design's PK(invitation_id, principal); a unique index works the same on every driver.
    await connection.index().unique().table('team_invitation_uses').name('team_invitation_uses_key').columns(['invitation_id', 'principal']);
    await connection.index().table('team_invitations').name('team_invitations_team').columns(['team_id']);
  }

  public async down(connection: OrmDriver): Promise<void> {
    await connection.schema().dropTable('team_invitation_uses');
    await connection.schema().dropTable('team_invitations');
  }
}
