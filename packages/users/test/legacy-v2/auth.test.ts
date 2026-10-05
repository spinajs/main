// Rewrite-class rows (LEDGER auth rows 6-9) moved here by C1 dispatch 6: SimpleDbAuthProvider.authenticate becomes
// LocalPasswordStrategy (N3). Excluded by .mocharc.json; T1 replaces and deletes them.
import { BasicPasswordProvider } from '../../src/password.js';
import { Bootstrapper, DI } from '@spinajs/di';
import chaiAsPromised from 'chai-as-promised';
import * as chai from 'chai';
import { PasswordProvider, SimpleDbAuthProvider, AuthProvider, User } from '../../src/index.js';
import { expect } from 'chai';
import { Configuration } from '@spinajs/configuration';

import { SqliteOrmDriver } from '@spinajs/orm-sqlite';
import { Orm } from '@spinajs/orm';
import { join, normalize, resolve } from 'path';
import { TestConfiguration } from '../common.test.js';

chai.use(chaiAsPromised);

function dir(path: string) {
  return resolve(normalize(join(process.cwd(), 'test', path)));
}

describe('Authorization provider tests', function () {
  // Every case boots the Orm, authz-rbac's migrations included: the default 2 s is too tight.
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

  afterEach(async () => {
    DI.clearCache();
  });

  it('Should authenticate', async () => {
    const provider = DI.resolve(AuthProvider);
    let result = await provider.authenticate('test@spinajs.pl', 'bbbb');
    expect(result).to.be.not.null;
  });

  it('should auth fail on banned user', async () => {
    const provider = DI.resolve(AuthProvider);
    await expect(provider.authenticate('test-banned@spinajs.pl', 'bbbb')).to.be.rejected;
  });

  it('should auth fail on user not active', async () => {
    const provider = DI.resolve(AuthProvider);
    await expect(provider.authenticate('test-notactive@spinajs.pl', 'bbbb')).to.be.rejected;
  });

  it('Should auth fail on user deleted', async () => {
    const provider = DI.resolve(AuthProvider);
    await expect(provider.authenticate('test-deleted@spinajs.pl', 'bbbb')).to.be.rejected;
  });
});
