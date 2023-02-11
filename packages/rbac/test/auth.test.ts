import { BasicPasswordProvider } from '../src/password.js';
import { DI } from '@spinajs/di';
import chaiAsPromised from 'chai-as-promised';
import * as chai from 'chai';
import { PasswordProvider, SimpleDbAuthProvider, AuthProvider, User, AthenticationErrorCodes } from '../src/index.js';
import { expect } from 'chai';
import { Configuration } from '@spinajs/configuration';

import { SqliteOrmDriver } from '@spinajs/orm-sqlite';
import { Orm } from '@spinajs/orm';
import { join, normalize, resolve } from 'path';
import { TestConfiguration } from './common.test.js';
import { DateTime } from 'luxon';

chai.use(chaiAsPromised);

function dir(path: string) {
  return resolve(normalize(join(process.cwd(), 'test', path)));
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
      IsActive: true,
      IsBanned: false,
    });

    await User.insert(user);

    const user2 = new User({
      Email: 'test2@spinajs.pl',
      NiceName: 'test',
      Login: 'test2',
      Password: await provider.hash('bbbb'),
      RegisteredAt: DateTime.now(),
      Role: 'admin',
      IsBanned: true,
      IsActive: true,
      DeletedAt: DateTime.now(),
    });

    await user2.insert();
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

  it('Should check for active user', async () => {
    const provider = DI.resolve(AuthProvider);
    let result = await provider.isActive('test2@spinajs.pl');

    expect(result).to.be.true;
  });
  it('Should check for deleted user', async () => {
    const provider = DI.resolve(AuthProvider);
    let result = await provider.isDeleted('test2@spinajs.pl');

    expect(result).to.be.true;
  });
  it('Should check for banned user', async () => {
    const provider = DI.resolve(AuthProvider);
    let result = await provider.isBanned('test2@spinajs.pl');

    expect(result).to.be.true;
  });

  it('Should return invalid credentials', async () => {
    const provider = DI.resolve(AuthProvider);

    let result = await provider.authenticate('test@spinajs.pl', 'dbbbb');
    expect(result.User).to.be.undefined;
    expect(result.Error).to.be.not.null;
    expect(result.Error).to.deep.equal({
      Code: AthenticationErrorCodes.E_INVALID_CREDENTIALS,
      Message: 'Invalid user credentials, or user not exist.',
    });

    result = await provider.authenticate('test@spinsajs.pl', 'bbbb');
    expect(result.Error).to.deep.equal({
      Code: AthenticationErrorCodes.E_INVALID_CREDENTIALS,
      Message: 'Invalid user credentials, or user not exist.',
    });
  });

  it('Should authenticate', async () => {
    const provider = DI.resolve(AuthProvider);
    let result = await provider.authenticate('test@spinajs.pl', 'bbbb');
    expect(result.User).to.be.not.null;
  });
});
