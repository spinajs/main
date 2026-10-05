// Rewrite-class rows (LEDGER user rows 13 and 14) moved here by C1 dispatch 1: they assert users.Role, which
// authz-rbac's migrations drop (H13). Rows 16-23 (User.can* on the 2.x AccessControl) moved by C1 task 13; drop
// row 15 deleted. Excluded by .mocharc.json; T1 replaces and deletes them.
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

  });

  describe('Permission checks (can*)', () => {
    beforeEach(() => {
      // editor has full :any grants on Article; viewer only has read:own
      const ac = DI.get<AccessControl>('AccessControl')!;
      ac.setGrants({
        editor: {
          Article: {
            'create:any': ['*'],
            'read:any': ['*'],
            'update:any': ['*'],
            'delete:any': ['*'],
          },
        },
        viewer: {
          Article: {
            'read:own': ['*'],
          },
        },
      });
    });

    const editor = () => new User({ Role: ['editor'] });
    const viewer = () => new User({ Role: ['viewer'] });

    it('canReadAny should work', () => {
      expect(editor().canReadAny('Article').granted).to.be.true;
      expect(viewer().canReadAny('Article').granted).to.be.false;
    });

    it('canUpdateAny should work', () => {
      expect(editor().canUpdateAny('Article').granted).to.be.true;
      expect(viewer().canUpdateAny('Article').granted).to.be.false;
    });

    it('canDeleteAny should work', () => {
      expect(editor().canDeleteAny('Article').granted).to.be.true;
      expect(viewer().canDeleteAny('Article').granted).to.be.false;
    });

    it('canCreateAny should work', () => {
      expect(editor().canCreateAny('Article').granted).to.be.true;
      expect(viewer().canCreateAny('Article').granted).to.be.false;
    });

    it('canReadOwn should work', () => {
      // an :any grant implies :own
      expect(editor().canReadOwn('Article').granted).to.be.true;
      expect(viewer().canReadOwn('Article').granted).to.be.true;
    });

    it('canUpdateOwn should work', () => {
      expect(editor().canUpdateOwn('Article').granted).to.be.true;
      expect(viewer().canUpdateOwn('Article').granted).to.be.false;
    });

    it('canDeleteOwn should work', () => {
      expect(editor().canDeleteOwn('Article').granted).to.be.true;
      expect(viewer().canDeleteOwn('Article').granted).to.be.false;
    });

    it('canCreateOwn should work', () => {
      expect(editor().canCreateOwn('Article').granted).to.be.true;
      expect(viewer().canCreateOwn('Article').granted).to.be.false;
    });
  });
});
