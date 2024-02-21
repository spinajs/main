import { BasicPasswordProvider } from '../src/password.js';
import { Constructor, DI } from '@spinajs/di';
import chaiAsPromised from 'chai-as-promised';
import * as chai from 'chai';
import { PasswordProvider, SimpleDbAuthProvider, AuthProvider, User, UserActivated } from '../src/index.js';
import { Configuration } from '@spinajs/configuration';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';
import { Orm } from '@spinajs/orm';
import { join, normalize, resolve } from 'path';
import { TestConfiguration } from './common.test.js';
import * as sinon from 'sinon';
import { expect } from 'chai';

import './migration/rbac.migration.js';
import { DefaultQueueService } from '@spinajs/queue';
import { activate } from '../src/actions.js';
import _ from 'lodash';
import { EmailSend } from '@spinajs/email';

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
    const eStub = sinon.stub(DefaultQueueService.prototype, 'emit').returns(Promise.resolve());

    let user = await User.query().whereAnything('test-notactive@spinajs.pl').firstOrFail();

    expect(user.IsActive).to.be.false;

    await activate('test-notactive@spinajs.pl');

    user = await User.query().whereAnything('test-notactive@spinajs.pl').firstOrFail();

    expect(user.IsActive).to.be.true;
    expect(eStub.calledTwice).to.be.true;
    expect((eStub.args[0] as any)[0]).to.be.instanceOf(UserActivated);
    expect((eStub.args[0] as any)[1]).to.be.instanceOf(EmailSend);
  });

  it('Should not send event when user is already activated', async () => {
    const eStub = sinon.stub(DefaultQueueService.prototype, 'emit').returns(Promise.resolve());

    await activate('test@spinajs.pl');

    const user = await User.query().whereAnything('test-notactive@spinajs.pl').firstOrFail();

    expect(user.IsActive).to.be.true;
    expect(eStub.calledTwice).to.be.true;
    expect((eStub.args[0] as any)[0]).to.be.instanceOf(UserActivated);
    expect((eStub.args[0] as any)[1]).to.be.instanceOf(EmailSend);
  });

  it('Should deactivate user', async () => {});

  it('Should create user', async () => {});

  it('Should delete user', async () => {});

  it('Should ban user', async () => {});

  it('Should unban user', async () => {});

  it('Should change password', async () => {});

  it('Should grant role', async () => {});

  it('Should revoke role', async () => {});

  it('Should update user', async () => {});

  it('Should authenticate user', async () => {});

  it('Password change request ', async () => {});

  it('Password change after request', async () => {});

  it('Password change after request with wrong token', async () => {});

  it('Password change after request with expired token', async () => {});
});
