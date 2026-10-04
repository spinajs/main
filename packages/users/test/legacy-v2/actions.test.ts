// Rewrite-class rows (LEDGER actions rows 41, 42, 82, 84-87) moved here by C1 dispatch 1: they assert users.Role,
// which authz-rbac's migrations drop (H13). Excluded by .mocharc.json; T1 replaces and deletes them.
import { BasicPasswordProvider } from '../../src/password.js';
import { Bootstrapper, DI } from '@spinajs/di';
import chaiAsPromised from 'chai-as-promised';
import * as chai from 'chai';
import { PasswordProvider, SimpleDbAuthProvider, AuthProvider, User, UserActivated, UserChanged, deactivate, UserDeactivated, create, UserCreated, deleteUser, UserDeleted, ban, unban, grant, revoke, changePassword, _user_update, passwordChangeRequest, confirmPasswordReset, passwordMatch, USER_COMMON_METADATA, login, UserLogged, UserBanned, UserUnbanned, UserPasswordChanged, UserPasswordChangeRequest, CreateMiddleware, SessionProvider, UserSession, issuePasswordResetToken } from '../../src/index.js';
import { Configuration } from '@spinajs/configuration';
import { InvalidArgument } from '@spinajs/exceptions';
import { UserAlreadyExists } from '../../src/exceptions.js';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';
import { Orm } from '@spinajs/orm';
import { join, normalize, resolve } from 'path';
import { TestConfiguration } from '../common.test.js';
import * as sinon from 'sinon';
import { expect } from 'chai';

import '../migration/rbac.migration.js';
import { DefaultQueueService } from '@spinajs/queue';
import { activate } from '../../src/actions.js';
import _ from 'lodash';
import { EmailSend } from '@spinajs/email';
import { UserMetadataChange } from '../../src/events/UserMetadataChange.js';
import { DateTime } from 'luxon';
import { UserLoginFailed } from '../../src/events/UserLoginFailed.js';
import { expirePassword } from '../../src/actions.js';
import { UserPasswordExpired } from '../../src/events/UserPasswordExpired.js';

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

    await DI.resolve(Configuration, [null, null, [dir('../config')]]);
    await DI.resolve(Orm);
  });

  afterEach(async () => {
    sinon.restore();

    DI.clearCache();
  });

  it('Should grant role', async () => {
    sinon.stub(DefaultQueueService.prototype, 'emit').returns(Promise.resolve(undefined));

    const before = await User.query().whereAnything('test@spinajs.pl').firstOrFail();
    expect(before.Role).to.not.include('editor');

    await grant('test@spinajs.pl', 'editor');

    const after = await User.query().whereAnything('test@spinajs.pl').firstOrFail();
    expect(after.Role).to.include('editor');

    // granting the same role twice must not duplicate it
    await grant('test@spinajs.pl', 'editor');
    const again = await User.query().whereAnything('test@spinajs.pl').firstOrFail();
    expect(again.Role.filter((r) => r === 'editor').length).to.eq(1);
  });

  it('Should revoke role', async () => {
    sinon.stub(DefaultQueueService.prototype, 'emit').returns(Promise.resolve(undefined));

    await grant('test@spinajs.pl', 'editor');
    let user = await User.query().whereAnything('test@spinajs.pl').firstOrFail();
    expect(user.Role).to.include('editor');

    await revoke('test@spinajs.pl', 'editor');
    user = await User.query().whereAnything('test@spinajs.pl').firstOrFail();
    expect(user.Role).to.not.include('editor');
  });

  it('Should trim and de-duplicate the role list', async () => {
    sinon.stub(DefaultQueueService.prototype, 'emit').returns(Promise.resolve(undefined));

    const { User: u } = await create('roles@wp.pl', 'roleuser', ['admin', ' admin ', 'guest'], { password: 'passw0rd123' });

    expect(u.Role).to.have.members(['admin', 'guest']);
    expect(u.Role, 'a duplicate would be checked twice by every downstream guard').to.have.lengthOf(2);
  });

  /**
   * A role absent from the grants map inserts fine and then fails inside
   * accesscontrol, far from whoever typed it.
   */
  it('Should refuse a role that is not configured in grants', async () => {
    sinon.stub(DefaultQueueService.prototype, 'emit').returns(Promise.resolve(undefined));

    await expect(create('bogus@wp.pl', 'bogususer', ['not-a-role'], { password: 'passw0rd123' })).to.be.rejectedWith(InvalidArgument, /not configured in rbac.grants or rbac.roles: not-a-role/);

    expect(await User.query().whereAnything('bogus@wp.pl').first()).to.not.exist;
  });

  it('Should refuse granting a role that is not configured in grants', async () => {
    sinon.stub(DefaultQueueService.prototype, 'emit').returns(Promise.resolve(undefined));

    await expect(grant('test@spinajs.pl', 'not-a-role')).to.be.rejectedWith(InvalidArgument, /not configured in rbac.grants or rbac.roles/);
  });

  /**
   * The escape hatch itself needs a test: without one, `rbac.requireKnownRole`
   * could regress into a no-op and nothing here would notice.
   */
  it('Should accept an undeclared role when rbac.requireKnownRole is false', async () => {
    sinon.stub(DefaultQueueService.prototype, 'emit').returns(Promise.resolve(undefined));

    const config = DI.get(Configuration)!;
    config.set('rbac.requireKnownRole', false);

    try {
      const { User: u } = await create('escapehatch@wp.pl', 'escapehatch', ['neither-grants-nor-roles'], { password: 'passw0rd123' });
      expect(u.Role).to.include('neither-grants-nor-roles');
    } finally {
      config.set('rbac.requireKnownRole', true);
    }
  });

  /**
   * `rbac.roles` may be assembled dynamically (the escape hatch above exists
   * for exactly that scenario), so one malformed entry must not turn a routine
   * refusal into an unhandled TypeError thrown before assertRolesExist ever
   * gets to report which role was the problem.
   */
  it('Should refuse an unknown role rather than throw when rbac.roles holds a malformed entry', async () => {
    sinon.stub(DefaultQueueService.prototype, 'emit').returns(Promise.resolve(undefined));

    const config = DI.get(Configuration)!;
    const original = config.get('rbac.roles');
    config.set('rbac.roles', [null, { Name: 'admin' }]);

    try {
      await expect(create('malformed-roles@wp.pl', 'malformedroles', ['not-a-role'], { password: 'passw0rd123' })).to.be.rejectedWith(InvalidArgument, /not configured in rbac.grants or rbac.roles: not-a-role/);
    } finally {
      config.set('rbac.roles', original);
    }
  });
});
