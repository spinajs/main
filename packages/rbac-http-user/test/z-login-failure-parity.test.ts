import 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';

import { Bootstrapper, DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { Orm } from '@spinajs/orm';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';
import { DefaultQueueService } from '@spinajs/queue';
import { Unauthorized } from '@spinajs/http';

import { AuthProvider, BasicPasswordProvider, MemorySessionStore, PasswordProvider, SessionProvider, SimpleDbAuthProvider, User } from '@spinajs/rbac';

import { LoginController } from '../src/controllers/LoginController.js';
import { DbTestConfiguration } from './db-common.js';

const body = async <T = any>(r: any): Promise<T> => await r.responseData;

/**
 * Every rejected login must be indistinguishable from every other rejected login.
 *
 * `login()` resolves the user before the AuthProvider ever runs, and that lookup
 * used to end in `firstOrFail()` — an `OrmNotFoundException`, which is neither
 * `ErrorCode` nor `InvalidArgument`, so the controller rethrew it and
 * `@spinajs/orm-http` mapped it to a 404. A wrong password answered 401. The pair
 * is an account-enumeration oracle: the status code alone told an attacker whether
 * an address is registered, and no client-side flattening of the two can take that
 * back from anyone holding curl.
 */
/*
 * Named `z-` on purpose: every database backed suite in this package leaves its
 * own Configuration, Orm and providers in the container, and one inserted in the
 * middle of the alphabetical run order makes the later `user-*` suites resolve a
 * User model with no connection. `z-controller-refresh.test.ts` carries the same
 * prefix for the same reason — a suite added here runs after the ones it would
 * otherwise disturb.
 */
describe('LoginController — failed logins are indistinguishable', function () {
  this.timeout(25000);

  let controller: LoginController;

  before(() => {
    DI.setESMModuleSupport();
  });

  beforeEach(async () => {
    // sibling suites in this package leave their own Configuration / providers
    // resolved in the container; start from a clean cache so this suite runs
    // against its own wiring regardless of file order
    DI.clearCache();

    DI.register(DbTestConfiguration).as(Configuration);
    DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
    DI.register(BasicPasswordProvider).as(PasswordProvider);
    DI.register(SimpleDbAuthProvider).as(AuthProvider);
    DI.register(MemorySessionStore).as(SessionProvider);
    DI.register(LoginController).as(LoginController);

    const bootstrappers = await DI.resolve(Array.ofType(Bootstrapper));
    for (const b of bootstrappers) {
      await b.bootstrap();
    }

    await DI.resolve(Configuration);
    await DI.resolve(Orm);

    sinon.stub(DefaultQueueService.prototype, 'emit').returns(Promise.resolve(undefined));

    controller = await DI.resolve(LoginController);

    const pwd = DI.resolve(BasicPasswordProvider);
    const user = new User({
      Uuid: 'cccccccc-1111-4111-8111-cccccccccccc',
      Email: 'registered@spinajs.pl',
      Login: 'registered-user',
      Password: await pwd.hash('current123'),
      Role: ['user'],
      IsActive: true,
    });
    await user.insert();
  });

  afterEach(async () => {
    sinon.restore();
    DI.clearCache();
  });

  it('answers Unauthorized for an email that is not registered', async () => {
    const result = await controller.login(undefined as any, undefined as any, {
      Email: 'never-registered@spinajs.pl',
      Password: 'current123',
    } as any);

    expect(result, 'an unknown email must not escape as an orm exception — that reaches the client as 404 and enumerates accounts').to.be.instanceOf(Unauthorized);

    const data = await body<any>(result);
    expect(data.error.code).to.equal('E_AUTH_FAILED');
  });

  it('answers Unauthorized for a registered email with the wrong password', async () => {
    const result = await controller.login(undefined as any, undefined as any, {
      Email: 'registered@spinajs.pl',
      Password: 'not-the-password',
    } as any);

    expect(result).to.be.instanceOf(Unauthorized);

    const data = await body<any>(result);
    expect(data.error.code).to.equal('E_AUTH_FAILED');
  });
});
