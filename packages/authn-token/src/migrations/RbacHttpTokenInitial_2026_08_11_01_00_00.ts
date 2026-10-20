import { OrmMigration, OrmDriver, Migration } from '@spinajs/orm';

const TABLE = 'rbac_access_tokens';

@Migration('default')
export class RbacHttpTokenInitial_2026_08_11_01_00_00 extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    await connection.schema().createTable(TABLE, (table) => {
      table.int('Id').primaryKey().autoIncrement();
      table.string('Uuid', 36).notNull();
      table.string('Name', 128).notNull();
      table.string('Token', 64).notNull();
      table.string('Roles', 512).notNull();
      table.string('Profile', 128);
      table.dateTime('ExpiresAt');
      table.dateTime('CreatedAt').notNull().default().dateTime();
      table.dateTime('LastUsedAt');
      table.int('user_id').notNull();
      table.text('Scope');
      table.string('Kind', 16).notNull().default().value('pat');
      table.dateTime('RevokedAt');
      table.string('LastUsedIp', 64);
      table.foreignKey('user_id').references('users', 'Id').cascade();
    });

    await connection.index().unique().table(TABLE).name('access_token_hash_idx').columns(['Token']);
    await connection.index().unique().table(TABLE).name('access_token_uuid_idx').columns(['Uuid']);
    await connection.index().table(TABLE).name('access_token_user_idx').columns(['user_id']);
    await connection.index().table(TABLE).name('access_token_expires_idx').columns(['ExpiresAt']);
  }

  public async down(connection: OrmDriver): Promise<void> {
    await connection.schema().dropTable(TABLE);
  }
}
