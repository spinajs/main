import { IDriverOptions, Migration, OrmDriver, OrmMigration } from '@spinajs/orm';
import { User } from '../../src/models/User.js';
import { v4 as uuidv4 } from 'uuid';
import { DI } from '@spinajs/di';
import { PasswordProvider } from '../../src/interfaces.js';
import { ban } from '../../src/commands.js';

export const TEST_USER_UUID = uuidv4();
export const TEST_USER_UUID_2 = uuidv4();
export const TEST_USER_UUID_3 = uuidv4();

@Migration('default')
export class RbacMigration_2022_06_28_01_13_00 extends OrmMigration {
  public async up(_connection: OrmDriver<IDriverOptions>): Promise<void> {}

  // tslint:disable-next-line: no-empty
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  public async down(_connection: OrmDriver<IDriverOptions>): Promise<void> {}

  public async data() {
    const provider = DI.resolve(PasswordProvider);

    const user = new User({
      Email: 'test@spinajs.pl',
      Login: 'test',
      Password: await provider.hash('bbbb'),
      Role: ['admin'],
      IsActive: true,
      Uuid: TEST_USER_UUID,
    });

    await user.insert();

    user.Metadata['test:test'] = 'test';

    await user.Metadata.sync();

    const bannedUser = new User({
      Email: 'test-banned@spinajs.pl',
      Login: 'test',
      Password: await provider.hash('bbbb'),
      Role: ['admin'],
      IsActive: true,
      Uuid: TEST_USER_UUID_3,
    });

    await bannedUser.insert();
    await ban(TEST_USER_UUID_3);

    const notActiveUser = new User({
      Email: 'test-notactive@spinajs.pl',
      Login: 'test',
      Password: await provider.hash('bbbb'),
      Role: ['admin'],
      IsActive: false,
      Uuid: uuidv4(),
    });

    await notActiveUser.insert();

    const deletedUser = new User({
      Email: 'test-deleted@spinajs.pl',
      Login: 'test',
      Password: await provider.hash('bbbb'),
      Role: ['admin'],
      IsActive: false,
      Uuid: uuidv4(),
    });

    await deletedUser.insert();
    await deletedUser.destroy();
  }
}
