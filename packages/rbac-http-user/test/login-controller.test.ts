import 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';

import { Bootstrapper, DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { Orm } from '@spinajs/orm';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';
import { DefaultQueueService } from '@spinajs/queue';
import { Ok } from '@spinajs/http';

import { AuthProvider, BasicPasswordProvider, MemorySessionStore, PasswordProvider, SessionProvider, SimpleDbAuthProvider, User } from '@spinajs/rbac';

import { LoginController } from '../src/controllers/LoginController.js';
import { DbTestConfiguration } from './db-common.js';

/**
 * `rbac.twoFactorAuth.forceUser: true` with the system-wide switch
 * (`rbac.twoFactorAuth.enabled`) off. Regression test for a lockout: every
 * mutating `/user/2fa*` and `/auth/2fa/setup` route is gated by
 * `TwoFactorAuthEnabled` and answers 403 while the switch is off, so a user
 * parked in `TwoFactorInitRequired` by `forceUser` alone would have had no
 * route out of that state.
 */
class ForceUserSystemDisabledConfiguration extends DbTestConfiguration {
  protected onLoad(): unknown {
    const base = super.onLoad() as Record<string, any>;

    return {
      ...base,
      rbac: {
        ...base.rbac,
        twoFactorAuth: { enabled: false, forceUser: true, service: 'Default2FaToken' },
      },
    };
  }
}

const body = async <T = any>(r: any): Promise<T> => await r.responseData;

describe('LoginController (database backed) — forceUser vs. system-wide switch', function () {
  this.timeout(25000);

  const USER_UUID = 'eeeeeeee-3333-4333-8333-eeeeeeeeeeee';

  let controller: LoginController;

  before(() => {
    DI.setESMModuleSupport();
  });

  beforeEach(async () => {
    // sibling suites in this package leave their own Configuration / providers
    // resolved in the container; start from a clean cache so this suite runs
    // against its own wiring regardless of file order
    DI.clearCache();

    DI.register(ForceUserSystemDisabledConfiguration).as(Configuration);
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
      Uuid: USER_UUID,
      Email: 'lockout@spinajs.pl',
      Login: 'lockout-user',
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

  it('does not answer TwoFactorInitRequired when the system-wide switch is off, even with forceUser on', async () => {
    const result = await controller.login(undefined as any, undefined as any, {
      Email: 'lockout@spinajs.pl',
      Password: 'current123',
    } as any);

    expect(result).to.be.instanceOf(Ok);

    const data = await body<any>(result);
    expect(data.TwoFactorInitRequired, 'must not park the user in TwoFactorInitRequired — there is no route out while the system switch is off').to.not.equal(true);
  });
});
