import { BasicPasswordProvider } from '../src/password.js';
import { Bootstrapper, DI } from '@spinajs/di';
import { AccessControl } from 'accesscontrol';
import chaiAsPromised from 'chai-as-promised';
import * as chai from 'chai';
import { PasswordProvider, SimpleDbAuthProvider, AuthProvider, User, UserMetadata } from '../src/index.js';
import { expect } from 'chai';
import { Configuration } from '@spinajs/configuration';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';
import { Orm } from '@spinajs/orm';
import { join, normalize, resolve } from 'path';
import { TestConfiguration } from './common.test.js';
import { DateTime } from 'luxon';

import './migration/rbac.migration.js';
import { TEST_USER_UUID, TEST_USER_UUID_2 } from './migration/rbac.migration.js';

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

  describe('Scope tests', () => {
    it('isActiveUser query scope should work', async () => {
      const user = await User.query().isActiveUser().first();
      expect(user).to.be.not.null;
    });

    it('whereEmail query scope should work', async () => {
      const user = await User.query().whereEmail('test@spinajs.pl').first();
      expect(user).to.be.not.null;
    });

    it('whereLogin query scope should work', async () => {
      const user = await User.query().whereLogin('test').first();
      expect(user).to.be.not.null;
    });

    it('getByLogin should work', async () => {
      const user = await User.getByLogin('test');
      expect(user).to.be.not.null;
    });

    it('getByEmail should work', async () => {
      const user = await User.getByEmail('test@spinajs.pl');
      expect(user).to.be.not.null;
    });

    it('getByUuid should work', async () => {
      const user = await User.getByUuid(TEST_USER_UUID);
      expect(user).to.be.not.null;
    });

    it('whereAnything should find a user by login', async () => {
      const user = await User.query().whereAnything('test').first();
      expect(user).to.be.not.null;
      expect((user as any).Login).to.eq('test');
    });

    it('whereAnything should find a user by email', async () => {
      const user = await User.query().whereAnything('test@spinajs.pl').first();
      expect(user).to.be.not.null;
    });

    it('whereAnything should find a user by id', async () => {
      const known = await User.query().whereLogin('test').firstOrFail();

      const user = await User.query().whereAnything(known.Id).first();
      expect(user).to.be.not.null;
      expect((user as any).Id).to.eq(known.Id);
    });

    it('whereAnything should find a user by a numeric id passed as string', async () => {
      const known = await User.query().whereLogin('test').firstOrFail();

      const user = await User.query().whereAnything(String(known.Id)).first();
      expect(user).to.be.not.null;
      expect((user as any).Id).to.eq(known.Id);
    });

    // Regression: the identifier was pushed through `_to_int()`, and
    // parseInt('9f8e7d6c-…') === 9 — so any uuid ( or login ) starting with a
    // digit was silently looked up as an Id and never found. About two thirds
    // of real uuid v4 values start with a digit.
    it('whereAnything should find a user by a uuid that starts with a digit', async () => {
      const uuid = '9f8e7d6c-1111-4111-8111-999999999999';

      await new User({
        Email: 'digit-uuid@spinajs.pl',
        Login: 'digit-uuid',
        Password: 'test',
        Uuid: uuid,
        IsActive: true,
      }).insert();

      const user = await User.query().whereAnything(uuid).first();

      expect(user, 'a uuid starting with a digit must not be treated as an id').to.be.not.null;
      expect((user as any).Login).to.eq('digit-uuid');
    });

    it('whereAnything should find a user by a login that starts with a digit', async () => {
      await new User({
        Email: 'digit-login@spinajs.pl',
        Login: '2fast4you',
        Password: 'test',
        Uuid: '11111111-2222-4222-8222-111111111111',
        IsActive: true,
      }).insert();

      const user = await User.query().whereAnything('2fast4you').first();

      expect(user).to.be.not.null;
      expect((user as any).Login).to.eq('2fast4you');
    });
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

  describe('User metadata', () => {
    it('Should get metadata', async () => {
      const user = await User.where('Email', 'test@spinajs.pl').populate('Metadata').first();

      expect(user.Metadata).to.be.not.null;
      expect(user.Metadata['test:test']).to.be.eq('test');
      expect(user.Metadata.length).to.be.eq(1);

      expect(user.Metadata['test:test:second']).to.be.null;
    });

    it('Should add metadata by assign', async () => {
      const user = await User.getByEmail('test@spinajs.pl');
      user.Metadata['test_2:test'] = 'test';

      expect(user.Metadata['test_2:test']).to.be.eq('test');

      await user.Metadata.sync();

      const meta = await UserMetadata.where('Key', 'test_2:test').first();
      expect(meta).to.be.not.null;
    });

    it('Should remove specific metadata by assingn ', async () => {
      const user = await User.getByEmail('test@spinajs.pl');
      user.Metadata['test:test'] = 'test';
      user.Metadata['test:test'] = null;

      expect(user.Metadata['test:test']).to.be.null;

      await user.Metadata.sync();

      const meta = await UserMetadata.where('Key', 'test:test').first();
      expect(meta).to.be.undefined;
    });

    it('Should remove all meta in category by assign', async () => {
      const user = await User.getByEmail('test@spinajs.pl');

      user.Metadata['test:test'] = 'test';
      user.Metadata['test:test:second'] = 'test2';

      await user.Metadata.sync();

      user.Metadata['test:*'] = null;

      expect(user.Metadata.length).to.be.eq(0);

      await user.Metadata.sync();

      const meta = await UserMetadata.where('Key', 'like', '%test:test');
      expect(meta.length).to.be.eq(0);
    });

    it('Should update metadata', async () => {
      const user = await User.getByEmail('test@spinajs.pl');

      await user.Metadata.populate();

      user.Metadata['test:test'] = 'test11';

      await user.Metadata.sync();

      let meta = await UserMetadata.where('Key', 'test:test').first();
      expect(meta.Value).to.be.eq('test11');

      user.Metadata['test:test'] = 'test-2';
      await user.Metadata.sync();

      meta = await UserMetadata.where('Key', 'test:test').first();
      expect(meta.Value).to.be.eq('test-2');
    });

    it('Should automatically convert meta value to number', async () => {
      const user = await User.getByEmail('test@spinajs.pl');
      user.Metadata['test:test'] = 1;

      await user.Metadata.sync();

      const meta = await UserMetadata.where('Key', 'test:test').first();
      expect(meta.Type).to.be.eq('number');
      expect(meta.Value).to.be.eq(1);
    });

    it('Should automatically convert meta value to json', async () => {
      const user = await User.getByEmail('test@spinajs.pl');
      user.Metadata['test:test'] = { Value: 1.0, Foo: 'sss' };

      await user.Metadata.sync();

      const meta = await UserMetadata.where('Key', 'test:test').first();
      expect(meta.Type).to.be.eq('json');
      expect(meta.Value).to.be.deep.eq({ Value: 1.0, Foo: 'sss' });
    });

    it('Should automatically convert meta value to boolean', async () => {
      const user = await User.getByEmail('test@spinajs.pl');
      user.Metadata['test:test'] = true;

      await user.Metadata.sync();

      const meta = await UserMetadata.where('Key', 'test:test').first();
      expect(meta.Type).to.be.eq('boolean');
      expect(meta.Value).to.be.eq(true);
    });

    it('Should automatically convert meta value to datetime', async () => {
      const user = await User.getByEmail('test@spinajs.pl');
      user.Metadata['test:test'] = DateTime.now();

      await user.Metadata.sync();
 
      const meta = await UserMetadata.where('Key', 'test:test').first();
      expect(meta.Type).to.be.eq('datetime');
      expect(meta.Value).to.be.instanceOf(DateTime);
    });

    it('Should filter metadata by key', async () => {
      const user = await User.where('Email', 'test@spinajs.pl').populate('Metadata').first();
      const meta = user.Metadata.filter((x) => x.Key === 'test:test');

      expect(meta.length).to.be.eq(1);
      expect(meta[0].Value).to.be.eq('test');
    });

    it('Should find metadata by key', async () => {
      const user = await User.where('Email', 'test@spinajs.pl').populate('Metadata').first();
      const meta = user.Metadata.find((x) => x.Key === 'test:test');

      expect(meta).to.be.not.undefined;
      expect(meta!.Value).to.be.eq('test');
    });
  });

  describe('Model tests', () => {
    it('Should get user by email', async () => {
      const user = await User.getByEmail('test@spinajs.pl');
      expect(user).to.be.not.undefined;

      const user2 = await User.getByEmail('test2@spinajs.pl');
      expect(user2).to.be.undefined;
    });

    it('Should get user by login', async () => {
      const user = await User.getByLogin('test');
      expect(user).to.be.not.undefined;
    });

    it('Should get user by uuid', async () => {
      const user = await User.getByUuid(TEST_USER_UUID);
      expect(user).to.be.not.undefined;
    });

    it('Should get user by id', async () => {
      const user = await User.get(1);
      expect(user).to.be.not.undefined;
    });

    it('Should throw if same email is used', async () => {
      const provider = DI.resolve(PasswordProvider);

      const user = new User({
        Email: 'test@spinajs.pl',
        Login: 'tesssst',
        Password: await provider.hash('bbbb'),
        Role: ['admin'],
        IsActive: true,
        Uuid: TEST_USER_UUID_2,
      });

      await expect(user.insert()).to.be.rejectedWith('SQLITE_CONSTRAINT: UNIQUE constraint failed: users.Email');
    });

    it('Should throw if same uuid is used', async () => {
      const provider = DI.resolve(PasswordProvider);

      const user = new User({
        Email: 'tessssst@spinajs.pl',
        Login: 'tesw222ssst',
        Password: await provider.hash('bbbb'),
        Role: ['admin'],
        IsActive: true,
        Uuid: TEST_USER_UUID,
      });

      await expect(user.insert()).to.be.rejectedWith('SQLITE_CONSTRAINT: UNIQUE constraint failed: users.Uuid');
    });

    it('Should throw if same login is used', async () => {
      const provider = DI.resolve(PasswordProvider);

      const user = new User({
        Email: 'test-22222@spinajs.pl',
        Login: 'test',
        Password: await provider.hash('bbbb'),
        Role: ['admin'],
        IsActive: true,
        Uuid: TEST_USER_UUID_2,
      });

      await expect(user.insert()).to.be.rejectedWith('SQLITE_CONSTRAINT: UNIQUE constraint failed: users.Login');
    });

    it('Should set soft delete date', async () => {
      const user = await User.get(1);
      expect(user.DeletedAt).to.be.null;
      await user.destroy();

      // Reads now filter `DeletedAt IS NULL` by default, so the soft-deleted row is
      // invisible to a plain get() — that is the point of the soft delete. `withDeleted()`
      // is the documented opt-out and the only way to observe the stamp.
      const user2 = await User.query().withDeleted().where('Id', 1).first();
      expect(user2).to.be.not.undefined;
      expect(user2.DeletedAt).to.be.not.null;
    });

    it('Should hide soft deleted rows from normal reads', async () => {
      const user = await User.get(1);
      await user.destroy();

      expect(await User.get(1)).to.be.undefined;
    });

    it('To json should hide password', async () => {
      const user = await User.get(1);

      expect(user.Password).to.be.not.null;
      expect(user.Password).to.be.not.undefined;

      expect(user.toJSON().Password).to.be.undefined;
    });
  });
});
