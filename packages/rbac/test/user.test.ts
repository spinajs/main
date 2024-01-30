import { BasicPasswordProvider } from '../src/password.js';
import { DI } from '@spinajs/di';
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

import "./migration/rbac.migration.js";
import { TEST_USER_UUID } from './migration/rbac.migration.js';

chai.use(chaiAsPromised);

function dir(path: string) {
  return resolve(normalize(join(process.cwd(), 'test', path)));
}
 

describe('User model tests', function() {

  this.timeout(15000);

  before(async () => {
    DI.register(SimpleDbAuthProvider).as(AuthProvider);
    DI.register(TestConfiguration).as(Configuration);
    DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
    DI.register(BasicPasswordProvider).as(PasswordProvider);
  });

  beforeEach(async () => {
    await DI.resolve(Configuration, [null, null, [dir('./config')]]);
    await DI.resolve(Orm);
  });

  afterEach(async () => {
    DI.clearCache();
  });

  it('To json should hide password', async () => {});

  describe('Scope tests', () => {
    it('isActiveUser query scope should work', async () => {});

    it('byEmail query scope should work', async () => {});

    it('byLogin query scope should work', async () => {});
  });

  describe('User roles', () => {
    it('Should chekc if guest role is set', async () => {});

    it('canReadAny should work', async () => {});

    it('canUpdateAny should work', async () => {});

    it('canDeleteAny should work', async () => {});

    it('canCreateAny should work', async () => {});

    it('canReadOwn should work', async () => {});

    it('canUpdateOwn should work', async () => {});

    it('canDeleteOwn should work', async () => {});

    it('canCreateOwn should work', async () => {});

    it('Should convert roles to and from string to array', async () => {});
  });

  describe('User metadata', () => {
    
    it('Should get metadata', async () => {

      const user = await User.where('Email', 'test@spinajs.pl').populate('Metadata').first();
      
      const val = user.Metadata['test:test'];
      console.log(val);
      expect(user.Metadata).to.be.not.null;
      expect(user.Metadata['test:test']).to.be.eq('test');
      expect(user.Metadata.length).to.be.eq(1);
    });

    it('Should add metadata by assign', async () => {
      const user = await User.getByEmail('test_2@spinajs.pl');
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
      expect(meta).to.be.null;
    });

    it('Should remove all meta in category by assign', async () => {
      const user = await User.getByEmail('test@spinajs.pl');

      user.Metadata['test:test'] = 'test';
      user.Metadata['test:test:second'] = 'test2';

      await user.Metadata.sync();

      user.Metadata["/(test:test).*/"] = null

      const meta = await UserMetadata.where('Key', 'like', '%test:test');
      expect(meta.length).to.be.eq(0);
    });

    it('Should update metadata', async () => {
      const user = await User.getByEmail('test@spinajs.pl');
      user.Metadata['test:test'] = 'test';

      await user.Metadata.sync();

      let meta = await UserMetadata.where('Key', 'test:test').first();
      expect(meta.Value).to.be.eq('test');

      user.Metadata['test:test'] = 'test-2';

      await user.Metadata.sync();

      await UserMetadata.where('Key', 'test').first();
      expect(meta.Value).to.be.eq('test:test');
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
  });

  describe('Model tests', () => {
    it('Should get user by email', async () => {
      const user = await User.getByEmail('test@spinajs.pl');
      expect(user).to.be.not.null;

      const user2 = await User.getByEmail('test2@spinajs.pl');
      expect(user2).to.be.null;
    });

    it('Should get user by login', async () => {
      const user = await User.getByLogin('test');
      expect(user).to.be.not.null;
    });

    it('Should get user by uuid', async () => {
      const user = await User.getByUuid(TEST_USER_UUID);
      expect(user).to.be.not.null;
    });

    it('Should get user by id', async () => {
      const user = await User.get(1);
      expect(user).to.be.not.null;
    });

    it('Should throw if same email is used', async () => {
      const provider = DI.resolve(PasswordProvider);

      const user = new User({
        Email: 'test@spinajs.pl',
        Login: 'tesssst',
        Password: await provider.hash('bbbb'),
        Role: ['admin'],
        IsActive: true,
        Uuid: TEST_USER_UUID,
      });

      await expect(user.insert()).to.be.rejectedWith('UNIQUE constraint failed: users.Email');
    });

    it('Should throw if same login is used', async () => {
      const provider = DI.resolve(PasswordProvider);

      const user = new User({
        Email: 'test@spinajs.pl',
        Login: 'tesssst',
        Password: await provider.hash('bbbb'),
        Role: ['admin'],
        IsActive: true,
        Uuid: TEST_USER_UUID,
      });

      await expect(user.insert()).to.be.rejectedWith('UNIQUE constraint failed: users.Login');
    });

    it('Should set soft delete date', async () => {
      const user = await User.get(1);
      expect(user.DeletedAt).to.be.null;
      await user.destroy();

      const user2 = await User.get(1);
      expect(user2.DeletedAt).to.be.not.null;
    });
  });
});
