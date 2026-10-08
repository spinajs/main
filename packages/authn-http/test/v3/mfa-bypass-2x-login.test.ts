import 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';

import { Bootstrapper, DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { Orm } from '@spinajs/orm';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';
import { DefaultQueueService } from '@spinajs/queue';
import { Ok } from '@spinajs/http';
import { MfaPolicy, MfaStep } from '@spinajs/authn/contracts';
import type { IdentityRef } from '@spinajs/authn/contracts';
import { TWO_FA_METATADATA_KEYS } from '@spinajs/authn-totp';

import { AuthProvider, BasicPasswordProvider, MemorySessionStore, PasswordProvider, SessionProvider, SimpleDbAuthProvider, User, getUser } from '@spinajs/users';

import { LoginController } from '../../src/account/controllers/LoginController.js';
import { DbTestConfiguration } from '../account-db-common.js';
import { TwoFacRouteEnabled } from '../../src/account/policies/2FaPolicy.js';

/** authn-totp ships no rbac.twoFactorAuth any more: the 2.x switch is unset. */
class NoTwoFactorSwitchConfiguration extends DbTestConfiguration {
  protected onLoad(): unknown {
    const base = super.onLoad() as Record<string, any>;
    const { twoFactorAuth: _dropped, ...rbac } = base.rbac;
    return { ...base, rbac, authn: { ...base.authn, mfa: { policy: { service: 'N8aLoginStubMfaPolicy' } } } };
  }
}

class N8aLoginStubMfaPolicy extends MfaPolicy {
  public static enrolled = new Set<string>();
  public static broken = false;
  public async required(id: IdentityRef): Promise<readonly string[]> {
    if (N8aLoginStubMfaPolicy.broken) throw new Error('policy store down');
    return N8aLoginStubMfaPolicy.enrolled.has(id.id) ? ['totp'] : [];
  }
}

class N8aLoginStubMfaStep extends MfaStep {
  public static enrolled = new Set<string>();
  public readonly name = 'stub';
  public async enrolled(id: IdentityRef): Promise<boolean> {
    return N8aLoginStubMfaStep.enrolled.has(id.id);
  }
  public async beginEnrolment(): Promise<{ provisioning: string }> {
    return { provisioning: '' };
  }
  public async confirmEnrolment(): Promise<{ recoveryCodes?: readonly string[] }> {
    return {};
  }
  public async verify(): Promise<boolean> {
    return false;
  }
  public async disable(): Promise<void> {}
}

// Fresh wiring per case without DI.clearCache(): drop only what this suite registers or depends on.
function uncacheOwn(): void {
  for (const t of [Configuration, Orm, SqliteOrmDriver, 'orm-driver-sqlite', SessionProvider, AuthProvider, PasswordProvider, LoginController, MfaPolicy]) DI.uncache(t as never);
}

const body = async <T = any>(r: any): Promise<T> => await r.responseData;

describe('2.x login with a second factor enrolled (N5 side effect)', function () {
  this.timeout(25000);

  const USER_UUID = 'eeeeeeee-4444-4444-8444-eeeeeeeeeeee';
  let controller: LoginController;
  let sessions: MemorySessionStore;

  const login = () => controller.login(undefined as any, undefined as any, { Email: 'mfa@spinajs.pl', Password: 'current123' } as any);

  before(() => {
    DI.setESMModuleSupport();
    // Registered once and never unregistered: DI.unregister leaves an empty key that later resolves trip over (N5
    // report). Only a config naming it in authn.mfa.policy.service selects it.
    DI.register(N8aLoginStubMfaPolicy).as(MfaPolicy);
    DI.register(N8aLoginStubMfaStep).as(MfaStep);
  });

  beforeEach(async () => {
    uncacheOwn();
    N8aLoginStubMfaPolicy.enrolled.clear();
    N8aLoginStubMfaPolicy.broken = false;
    N8aLoginStubMfaStep.enrolled.clear();

    DI.register(NoTwoFactorSwitchConfiguration).as(Configuration);
    DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
    DI.register(BasicPasswordProvider).as(PasswordProvider);
    DI.register(SimpleDbAuthProvider).as(AuthProvider);
    DI.register(MemorySessionStore).as(SessionProvider);
    DI.register(LoginController).as(LoginController);

    for (const b of await DI.resolve(Array.ofType(Bootstrapper))) {
      await b.bootstrap();
    }
    await DI.resolve(Configuration);
    await DI.resolve(Orm);

    sinon.stub(DefaultQueueService.prototype, 'emit').returns(Promise.resolve(undefined));

    controller = await DI.resolve(LoginController);
    sessions = (await DI.resolve(SessionProvider)) as MemorySessionStore;

    const user = new User({
      Uuid: USER_UUID,
      Email: 'mfa@spinajs.pl',
      Login: 'mfa-user',
      Password: await DI.resolve(BasicPasswordProvider).hash('current123'),
      Role: ['user'],
      IsActive: true,
    });
    await user.insert();
  });

  afterEach(async () => {
    sinon.restore();
    uncacheOwn();
  });

  const savedSession = async () => {
    const spy = (sessions.save as sinon.SinonSpy).getCall(0);
    return spy.args[0];
  };

  it('refuses the password alone for a user enrolled through 2.x, with the 2.x switch unset', async () => {
    const u = await getUser('mfa@spinajs.pl');
    u.Metadata[TWO_FA_METATADATA_KEYS.ENABLED] = true;
    await u.Metadata.update();

    sinon.spy(sessions, 'save');
    const result = await login();

    expect(result).to.be.instanceOf(Ok);
    const data = await body<any>(result);
    expect(data.TwoFactorAuthRequired).to.equal(true);
    expect(data).to.not.have.property('Uuid');
    expect((await savedSession()).Data.get('Authorized')).to.equal(false);
  });

  it('refuses the password alone for a user the 3.0 MfaPolicy requires a step of', async () => {
    N8aLoginStubMfaPolicy.enrolled.add(USER_UUID);

    sinon.spy(sessions, 'save');
    const data = await body<any>(await login());

    expect(data.TwoFactorAuthRequired).to.equal(true);
    expect((await savedSession()).Data.get('Authorized')).to.equal(false);
  });

  it('still authorizes a user with no second factor', async () => {

    sinon.spy(sessions, 'save');
    const data = await body<any>(await login());

    expect(data.TwoFactorAuthRequired).to.not.equal(true);
    expect((await savedSession()).Data.get('Authorized')).to.equal(true);
  });
  it('parks a 3.0-only login without the 2.x marker, so the 2.x enrol and verify routes stay shut', async () => {
    N8aLoginStubMfaPolicy.enrolled.add(USER_UUID);

    sinon.spy(sessions, 'save');
    await login();
    const session = await savedSession();

    expect(session.Data.get('Authorized')).to.equal(false);
    expect(session.Data.has('TwoFactorAuth')).to.equal(false);
    let refused = false;
    await new TwoFacRouteEnabled().execute({ storage: { Session: session } } as any).catch(() => (refused = true));
    expect(refused, 'the 2.x login-window routes refuse the session').to.equal(true);
  });

  /** No MfaPolicy under the configured name (the @spinajs/authn root entry is not loaded); over replaces config keys. */
  const PROPERTY_OF: Record<string, string> = {
    'authn.mfa.policy.service': 'MfaPolicyService',
    'authn.mfa.steps': 'MfaSteps',
    'authn.mfa.policy.force': 'MfaForce',
    'authn.mfa.policy.forceForRoles': 'MfaForceForRoles',
  };
  const withoutPolicy = (over: Record<string, unknown> = {}) => {
    for (const [key, value] of Object.entries({ 'authn.mfa.policy.service': 'NoSuchMfaPolicy', ...over })) {
      Object.defineProperty(controller, PROPERTY_OF[key], { value, configurable: true });
    }
  };

  const authorized = async () => {
    sinon.spy(sessions, 'save');
    await login();
    return (await savedSession()).Data.get('Authorized');
  };

  it('without the policy, authorizes a user with no factor even though steps are registered', async () => {
    expect(DI.getRegisteredTypes(MfaStep as never).length, 'authn-totp and this suite register MFA steps').to.be.greaterThan(0);
    withoutPolicy();
    expect(await authorized()).to.equal(true);
  });

  it('without the policy, keeps the login pending when a configured step is enrolled', async () => {
    withoutPolicy({ 'authn.mfa.steps': [{ name: 'stub', service: 'N8aLoginStubMfaStep' }] });
    N8aLoginStubMfaStep.enrolled.add(USER_UUID);
    expect(await authorized()).to.equal(false);
  });

  it('without the policy, authorizes when the configured step is not enrolled', async () => {
    withoutPolicy({ 'authn.mfa.steps': [{ name: 'stub', service: 'N8aLoginStubMfaStep' }] });
    expect(await authorized()).to.equal(true);
  });

  it('without the policy, a registered step the config does not list does not count', async () => {
    withoutPolicy();
    N8aLoginStubMfaStep.enrolled.add(USER_UUID);
    expect(await authorized()).to.equal(true);
  });

  it('without the policy, keeps the login pending for a configured step that is not registered', async () => {
    withoutPolicy({ 'authn.mfa.steps': [{ name: 'webauthn', service: 'NoSuchMfaStep' }] });
    expect(await authorized()).to.equal(false);
  });

  it('without the policy, force with a configured step keeps the login pending', async () => {
    withoutPolicy({ 'authn.mfa.steps': [{ name: 'stub', service: 'N8aLoginStubMfaStep' }], 'authn.mfa.policy.force': true });
    expect(await authorized()).to.equal(false);
  });

  it('keeps the login pending when the policy throws', async () => {
    N8aLoginStubMfaPolicy.broken = true;

    sinon.spy(sessions, 'save');
    const data = await body<any>(await login());

    expect(data.TwoFactorAuthRequired).to.equal(true);
    expect((await savedSession()).Data.get('Authorized')).to.equal(false);
  });
});
