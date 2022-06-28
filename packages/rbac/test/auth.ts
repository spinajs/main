import { BasicPasswordProvider } from '../src/password';
import { DI } from '@spinajs/di';
import chaiAsPromised from 'chai-as-promised';
import * as chai from 'chai';
import { PasswordProvider, SimpleDbAuthProvider, AuthProvider, User } from '../src';
import { expect } from 'chai';
import { Configuration } from '@spinajs/configuration';

import { SqliteOrmDriver } from '@spinajs/orm-sqlite';
import { Orm } from '@spinajs/orm';
import { join, normalize, resolve } from 'path';
import { TestConfiguration } from './common';

chai.use(chaiAsPromised);

function dir(path: string) {
  return resolve(normalize(join(__dirname, path)));
}

describe('Authorization provider tests', () => {
  before(async () => {
    DI.register(SimpleDbAuthProvider).as(AuthProvider);
    DI.register(TestConfiguration).as(Configuration);
    DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
    DI.register(BasicPasswordProvider).as(PasswordProvider);
  });

  beforeEach(async () => {
    await DI.resolve(Configuration, [null, null, [dir('./config')]]);
    await DI.resolve(Orm);
    const provider = DI.resolve(PasswordProvider);

    const user = new User({
      Email: 'test@spinajs.pl',
      NiceName: 'test',
      Login: 'test',
      Password: await provider.hash('bbbb'),
      RegisteredAt: new Date(),
      Role: 'admin',
    });

    await User.insert(user);
  });

  afterEach(async () => {
    DI.clearCache();
  });

  it('Should exists', async () => {
    const provider = DI.resolve(AuthProvider);
    let result = await provider.exists('test@spinajs.pl');
    expect(result).to.be.true;

    result = await provider.exists(
      new User({
        Email: 'test@spinajs.pl',
      }),
    );
    expect(result).to.be.true;

    result = await provider.exists('dasda@dasd.pl');
    expect(result).to.be.false;
  });

  it('Should authenticate', async () => {
    const provider = DI.resolve(AuthProvider);
    let user = await provider.authenticate('test@spinajs.pl', 'bbbb');
    expect(user).to.be.not.null;

    user = await provider.authenticate('test@spinajs.pl', 'dbbbb');
    expect(user).to.be.null;

    user = await provider.authenticate('test@spinsajs.pl', 'bbbb');
    expect(user).to.be.null;
  });
});
