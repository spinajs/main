import { IDriverOptions, Migration, OrmDriver, OrmMigration } from '@spinajs/orm';
import { USER_COMMON_METADATA, User } from '../../src/models/User.js';
import { v4 as uuidv4 } from 'uuid';
import { testHasher } from '../support/hasher.js';
import { AUTHZ_ASSIGNMENT_TABLE } from '@spinajs/authz-rbac';
//import { ban } from '../../src/actions.js';

export const TEST_USER_UUID = uuidv4();
export const TEST_USER_UUID_2 = uuidv4();
export const TEST_USER_UUID_3 = uuidv4();

/** A live GLOBAL assignment row, as the authz-rbac copy migration writes a 2.x `users.Role` entry. */
async function seedGlobalRole(uuid: string, role: string): Promise<void> {
  await User.query()
    .Driver.insert()
    .into(AUTHZ_ASSIGNMENT_TABLE)
    .values({ id: uuidv4(), subject_type: 'user', subject_id: uuid, subject_role: '', subject_key: `user:${uuid}`, role, scope_type: '$global', scope_id: '', tags: '', expires_at: null, granted_by: null, source: 'test', created_at: new Date() });
}

@Migration('default')
export class RbacMigration_2022_06_28_01_13_00 extends OrmMigration {
  public async up(connection: OrmDriver<IDriverOptions>): Promise<void> {

    await connection.schema().createTable('test', (table) =>{
      table.int('Id').primaryKey().autoIncrement();
      table.int('UserId');
      table.string('Value');
    });

    // agency_id: second relation to test_client, for the two-relations-to-one-model case
    await connection.schema().createTable('test_campaign', (table) => {
      table.int('Id').primaryKey().autoIncrement();
      table.int('client_id');
      table.int('agency_id');
    });

    // scope_id: lets a client be filtered through a joined table (test_scope) rather than a
    // plain column, the case where the rbac hook has to JOIN instead of adding a WHERE
    await connection.schema().createTable('test_client', (table) => {
      table.int('Id').primaryKey().autoIncrement();
      table.int('type');
      table.int('scope_id');
      table.string('Name', 64);
    });

    await connection.schema().createTable('test_scope', (table) => {
      table.int('Id').primaryKey().autoIncrement();
      table.string('code', 64);
    });
  }

  // tslint:disable-next-line: no-empty
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  public async down(_connection: OrmDriver<IDriverOptions>): Promise<void> {}

  public async data() {

    const user = new User({
      Email: 'test@spinajs.pl',
      Login: 'test',
      Password: await testHasher.hash('bbbb'),
      IsActive: true,
      Uuid: TEST_USER_UUID,
    });

    await user.insert();
    await seedGlobalRole(user.Uuid, 'admin');

    user.Metadata['test:test'] = 'test';

    await user.Metadata.sync();

    const bannedUser = new User({
      Email: 'test-banned@spinajs.pl',
      Login: 'test-banned',
      Password: await testHasher.hash('bbbb'),
      IsActive: true,
      Uuid: TEST_USER_UUID_3,
    });

    await bannedUser.insert();
    await seedGlobalRole(bannedUser.Uuid, 'admin');
    
    bannedUser.Metadata[USER_COMMON_METADATA.USER_BAN_IS_BANNED] = true;
    await bannedUser.Metadata.sync();

    const notActiveUser = new User({
      Email: 'test-notactive@spinajs.pl',
      Login: 'test-notactive',
      Password: await testHasher.hash('bbbb'),
      IsActive: false,
      Uuid: uuidv4(),
    });

    await notActiveUser.insert();
    await seedGlobalRole(notActiveUser.Uuid, 'admin');

    const deletedUser = new User({
      Email: 'test-deleted@spinajs.pl',
      Login: 'test-deleted',
      Password: await testHasher.hash('bbbb'),
      IsActive: false,
      Uuid: uuidv4(),
    });

    await deletedUser.insert();
    await seedGlobalRole(deletedUser.Uuid, 'admin');
    await deletedUser.destroy();
  }
}
