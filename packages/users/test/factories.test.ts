import { BasicPasswordProvider } from '../src/password.js';
import { Bootstrapper, DI } from '@spinajs/di';
import chaiAsPromised from 'chai-as-promised';
import * as chai from 'chai';
import { expect } from 'chai';
import * as sinon from 'sinon';
import { Configuration } from '@spinajs/configuration';
import { InvalidArgument } from '@spinajs/exceptions';
import { Orm } from '@spinajs/orm';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';
import { DefaultQueueService } from '@spinajs/queue';
import { SYSTEM } from '@spinajs/authz';
import { join, normalize, resolve } from 'path';

import { AuthProvider, PasswordProvider, SimpleDbAuthProvider, SYSTEM_LOGIN, User, isReservedLogin } from '../src/index.js';
import { assertUserUnique, create } from '../src/actions.js';
import { TestConfiguration } from './common.test.js';
import { TEST_USER_UUID } from './migration/rbac.migration.js';
import { registerAuthzHost, rootAuthz } from './support/authz-host.js';

chai.use(chaiAsPromised);

function dir(path: string) {
  return resolve(normalize(join(process.cwd(), 'test', path)));
}

describe('users DI factories (deprecated, 2.x consumers)', function () {
  this.timeout(30000);

  before(() => {
    DI.register(SimpleDbAuthProvider).as(AuthProvider);
    DI.register(TestConfiguration).as(Configuration);
    DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
    DI.register(BasicPasswordProvider).as(PasswordProvider);
    registerAuthzHost();
  });

  beforeEach(async () => {
    sinon.stub(DefaultQueueService.prototype, 'emit').returns(Promise.resolve(undefined));

    for (const b of await DI.resolve(Array.ofType(Bootstrapper))) {
      await b.bootstrap();
    }

    await DI.resolve(Configuration, [null, null, [dir('./config')]]);
    await DI.resolve(Orm);
  });

  afterEach(() => {
    sinon.restore();
    DI.clearCache();
  });

  describe('RbacUserFactory', () => {
    it('restores an active user by Uuid, with metadata, as SYSTEM', async () => {
      const runAs = sinon.spy(await rootAuthz(), 'runAs');

      const user = await DI.resolve<Promise<User>>('RbacUserFactory', [TEST_USER_UUID]);

      expect(user.Login).to.eq('test');
      expect(user.Metadata['test:test']).to.eq('test');
      expect(runAs.firstCall.args.slice(0, 2)).to.deep.eq([SYSTEM, 'session-restore']);
    });

    it('does not restore an inactive user', async () => {
      const inactive = await User.query().whereLogin('test-notactive').firstOrFail();

      await expect(DI.resolve<Promise<User>>('RbacUserFactory', [inactive.Uuid])).to.be.rejected;
    });
  });

  describe('RbacGuestUserFactory', () => {
    it('builds a never-stored guest without roles, inactive unless authz.principals.anonymous.enabled', async () => {
      const guest = DI.resolve<User>('RbacGuestUserFactory');

      expect(guest.Login).to.eq('guest');
      expect(guest.IsGuest).to.eq(true);
      expect(guest.IsActive).to.eq(false);
      expect(guest.Role).to.eq(undefined);
    });

    it('is active when authz.principals.anonymous.enabled is true', async () => {
      DI.get(Configuration)!.set('authz.principals.anonymous.enabled', true);

      expect(DI.resolve<User>('RbacGuestUserFactory').IsActive).to.eq(true);
    });
  });

  describe('RbacSystemUserFactory', () => {
    it(`finds the ${SYSTEM_LOGIN} account as SYSTEM`, async () => {
      await new User({ Email: 'system@spinajs.pl', Login: SYSTEM_LOGIN, Password: 'x', IsActive: true }).insert();
      const runAs = sinon.spy(await rootAuthz(), 'runAs');

      const system = await DI.resolve<Promise<User>>('RbacSystemUserFactory');

      expect(system.Login).to.eq(SYSTEM_LOGIN);
      expect(runAs.firstCall.args.slice(0, 2)).to.deep.eq([SYSTEM, 'system-user']);
    });
  });

  describe('reserved logins', () => {
    for (const login of [SYSTEM_LOGIN, '__anything__']) {
      it(`create() refuses the login ${login}`, async () => {
        const err = await create({ Email: `${login.replace(/_/g, 'x')}@spinajs.pl`, Login: login, Password: 'passw0rd123' }).then(
          () => undefined,
          (e: unknown) => e,
        );

        expect(err).to.be.instanceOf(InvalidArgument);
        expect((err as InvalidArgument).fieldName).to.eq('login');
        expect(await User.query().withDeleted().whereLogin(login).first()).to.not.exist;
      });
    }

    for (const login of [SYSTEM_LOGIN, '＿＿system＿＿']) {
      it(`assertUserUnique refuses the login ${login}, so a rename cannot take it`, async () => {
        const err = await assertUserUnique(login, undefined, 1).then(
          () => undefined,
          (e: unknown) => e,
        );

        expect(err).to.be.instanceOf(InvalidArgument);
        expect((err as InvalidArgument).fieldName).to.eq('login');
      });
    }

    it('counts a full-width underscore as an underscore', () => {
      expect(isReservedLogin('＿＿system＿＿')).to.eq(true);
      expect(isReservedLogin('_system_')).to.eq(false);
    });
  });

  it("keeps the deprecated 'AccessControl' registration for 2.x consumers", () => {
    expect(DI.get('AccessControl')).to.not.eq(undefined);
  });
});
