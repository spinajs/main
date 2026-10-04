// Rewrite-class rows (LEDGER user rows 13-15) moved here by C1 dispatch 1: they assert users.Role,
// which authz-rbac's migrations drop (H13). Excluded by .mocharc.json; T1 replaces and deletes them.
import { BasicPasswordProvider } from '../../src/password.js';
import { Bootstrapper, DI } from '@spinajs/di';
import { AccessControl } from 'accesscontrol';
import chaiAsPromised from 'chai-as-promised';
import * as chai from 'chai';
import { PasswordProvider, SimpleDbAuthProvider, AuthProvider, User, UserMetadata } from '../../src/index.js';
import { expect } from 'chai';
import { Configuration } from '@spinajs/configuration';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';
import { Orm } from '@spinajs/orm';
import { join, normalize, resolve } from 'path';
import { TestConfiguration } from '../common.test.js';
import { DateTime } from 'luxon';

import '../migration/rbac.migration.js';
import { TEST_USER_UUID, TEST_USER_UUID_2 } from '../migration/rbac.migration.js';

chai.use(chaiAsPromised);

function dir(path: string) {
  return resolve(normalize(join(process.cwd(), 'test', path)));
}

describe('User model tests', function () {
  this.timeout(15000);

  before(async () => {
    DI.register(SimpleDbAuthProvider).as(AuthProvider);
    DI.register(TestConfiguration).as(Configuration);
    DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
    DI.register(BasicPasswordProvider).as(PasswordProvider);
  });

  beforeEach(async () => {
    const bootstrappers = await DI.resolve(Array.ofType(Bootstrapper));
    for (const b of bootstrappers) {
      await b.bootstrap();
    }

    await DI.resolve(Configuration, [null, null, [dir('./config')]]);
    await DI.resolve(Orm);
  });

  afterEach(() => {
    DI.clearCache();
  });

  describe('User roles', () => {
    it('Should check if guest role is set by default', async () => {
      const user = new User({
        Email: 'test@test.pl',
        Login: 'tes t',
        IsActive: true,
        Password: 'test',
        Uuid: TEST_USER_UUID_2,
      });

      expect(user.IsGuest).to.be.true;

      await user.insert();

      const user2 = await User.get(user.Id);
      expect(user2.IsGuest).to.be.true;
      expect(user2.Role.length).to.be.eq(1);
    });

    it('Should save multiple roles', async () => {
      const user = new User({
        Email: 'test@test.pl',
        Login: 'test ddd',
        IsActive: true,
        Uuid: TEST_USER_UUID_2,
        Password: 'test',
        Role: ['admin', 'user'],
      });

      await user.insert();

      const user2 = await User.get(user.Id);
      expect(user2.Role.length).to.be.eq(2);
    });

    it('Should convert roles to and from string to array', async () => {
      const user = new User({
        Email: 'roles@test.pl',
        Login: 'roles user',
        IsActive: true,
        Uuid: TEST_USER_UUID_2,
        Password: 'test',
        Role: ['admin', 'user', 'editor'],
      });

      await user.insert();

      // Role is stored as a delimited string (@Set) and must hydrate back to an array
      const reloaded = await User.get(user.Id);
      expect(reloaded.Role).to.be.an('array');
      expect(reloaded.Role).to.have.members(['admin', 'user', 'editor']);
    });
  });
});
