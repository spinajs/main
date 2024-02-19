import { BasicPasswordProvider } from '../src/password.js';
import { DI } from '@spinajs/di';
import chaiAsPromised from 'chai-as-promised';
import * as chai from 'chai';
import { PasswordProvider, SimpleDbAuthProvider, AuthProvider } from '../src/index.js';
import { Configuration } from '@spinajs/configuration';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';
import { Orm } from '@spinajs/orm';
import { join, normalize, resolve } from 'path';
import { TestConfiguration } from './common.test.js';

import './migration/rbac.migration.js';
//import { pipe, Effect } from 'effect';
import { _usr, _clr_meta, _email } from '../src/actions.js';
import { Effect } from 'effect';

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
    await DI.resolve(Configuration, [null, null, [dir('./config')]]);
    await DI.resolve(Orm);
  });

  afterEach(async () => {
    DI.clearCache();
  });

  it('Should activate user', async () => {

    // await Effect.runPromise(pipe(_usr('test@spinajs.pl'),_clr_meta('meta-test')));
    //   .then((u) => {
    //     console.log(u);
    //   }).catch((e) => {
    //     console.log(e);
    //   });

    await Effect.runPromise(_usr("test").pipe(_email('banned')));


  });

  it('Should deactivate user', async () => { });

  it('Should create user', async () => { });

  it('Should delete user', async () => { });

  it('Should ban user', async () => { });

  it('Should unban user', async () => { });

  it('Should change password', async () => { });

  it('Should grant role', async () => { });

  it('Should revoke role', async () => { });

  it('Should update user', async () => { });

  it('Should authenticate user', async () => { });

  it('Password change request ', async () => { });

  it('Password change after request', async () => { });

  it('Password change after request with wrong token', async () => { });

  it('Password change after request with expired token', async () => { });
});
