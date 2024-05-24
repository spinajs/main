import { BasicPasswordProvider } from '../src/password.js';
import { Bootstrapper, DI } from '@spinajs/di';
import chaiAsPromised from 'chai-as-promised';
import * as chai from 'chai';
import { PasswordProvider, SimpleDbAuthProvider, AuthProvider, User, UserActivated, UserChanged, deactivate, UserDeactivated, create, UserCreated, deleteUser, UserDeleted } from '../src/index.js';
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
    const bootstrappers = await DI.resolve(Array.ofType(Bootstrapper));
    for (const b of bootstrappers) {
      await b.bootstrap();
    }

    await DI.resolve(Configuration, [null, null, [dir('./config')]]);
    await DI.resolve(Orm);
  });

  afterEach(async () => {
    sinon.restore();

    DI.clearCache();
  });

  it('Should activate user', async () => {
    const eStub = sinon.stub(DefaultQueueService.prototype, 'emit').returns(Promise.resolve());

    let user = await User.query().whereAnything('test-notactive@spinajs.pl').firstOrFail();

    expect(user.IsActive).to.eq(false);
    await activate('test-notactive@spinajs.pl');

    user = await User.query().whereAnything('test-notactive@spinajs.pl').firstOrFail();

    expect(user.IsActive).to.eq(true);
    expect(eStub.callCount).to.eq(3);
    expect((eStub.args[0] as any)[0]).to.be.instanceOf(UserChanged);
    expect((eStub.args[1] as any)[0]).to.be.instanceOf(UserActivated);
    expect((eStub.args[2] as any)[0]).to.be.instanceOf(EmailSend);
  });

  it('Should not send event when user is already activated', async () => {
    expect(activate('test@spinajs.pl')).to.be.rejected;
  });

  it('Should deactivate user', async () => {
    const eStub = sinon.stub(DefaultQueueService.prototype, 'emit').returns(Promise.resolve());

    let user = await User.query().whereAnything('test@spinajs.pl').firstOrFail();
    expect(user.IsActive).to.eq(true);
    await deactivate('test@spinajs.pl');

    user = await User.query().whereAnything('test@spinajs.pl').firstOrFail();
    expect(user.IsActive).to.eq(false);
    expect(eStub.callCount).to.eq(3);
    expect((eStub.args[0] as any)[0]).to.be.instanceOf(UserChanged);
    expect((eStub.args[1] as any)[0]).to.be.instanceOf(UserDeactivated);
    expect((eStub.args[2] as any)[0]).to.be.instanceOf(EmailSend);
  });

  it('Should create user', async () => {
    const eStub = sinon.stub(DefaultQueueService.prototype, 'emit').returns(Promise.resolve());

    const { User: U, Password } = await create('test@wp.pl', 'test', 'bbbb', ['admin']);

    const user = await User.query().whereAnything('test@wp.pl').firstOrFail();
    expect(user).to.be.not.null;
    expect(user.IsActive).to.eq(false);
    expect(user.Login).to.eq('test');
    expect(user.Email).to.eq('test@wp.pl');
    expect(user.Role).to.include('admin');

    expect(eStub.callCount).to.eq(2);
    expect((eStub.args[0] as any)[0]).to.be.instanceOf(UserCreated);
    expect((eStub.args[1] as any)[0]).to.be.instanceOf(EmailSend);

    expect(U).to.be.instanceOf(User);
    expect(Password).to.be.not.null;
    expect(Password).to.be.a('string');
  });

  it('Shouldn create user with already existing email', async () => {
    expect(create('test@spinajs.pl', 'test', 'bbbb', ['admin'])).to.be.rejected;
  });

  it('Shouldn create user with already existing login', async () => {
    expect(create('dasda@wp.pl', 'test', 'bbbb', ['admin'])).to.be.rejected;
  });

  it('Should delete user', async () => {
    const eStub = sinon.stub(DefaultQueueService.prototype, 'emit').returns(Promise.resolve());

    let user = await User.query().whereAnything('test@spinajs.pl').firstOrFail();

    expect(user).to.be.not.null;

    await deleteUser(user);

    user = await User.query().whereAnything('test@spinajs.pl').first();

    expect(user).to.be.not.null;
    expect(user.DeletedAt).to.be.not.null;

    expect(eStub.callCount).to.eq(2);
    expect((eStub.args[0] as any)[0]).to.be.instanceOf(UserDeleted);
    expect((eStub.args[1] as any)[0]).to.be.instanceOf(EmailSend);
  });

  it('Should ban user', async () => {});

  it('Should unban user', async () => {});

  it('Should change password', async () => {});

  it('Should grant role', async () => {});

  it('Should revoke role', async () => {});

  it('Should update user', async () => {});

  it('Should authenticate user', async () => {});

  it('Should reject auth with invalid password', async () => {});

  it('Password change request ', async () => {});

  it('Password change after request', async () => {});

  it('Password change after request with wrong token', async () => {});

  it('Password change after request with expired token', async () => {});
});
