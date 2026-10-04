import { BasicPasswordProvider } from '../src/password.js';
import { Bootstrapper, DI, Injectable } from '@spinajs/di';
import chaiAsPromised from 'chai-as-promised';
import * as chai from 'chai';
import { expect } from 'chai';
import * as sinon from 'sinon';
import { Configuration } from '@spinajs/configuration';
import { InvalidArgument, ResourceNotFound } from '@spinajs/exceptions';
import { Connection, Model, Orm } from '@spinajs/orm';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';
import { DefaultQueueService } from '@spinajs/queue';
import { SYSTEM } from '@spinajs/authz';
import type { Principal } from '@spinajs/authz';
import { PrincipalFactory } from '@spinajs/authn/contracts';
import type { AuthnFacts } from '@spinajs/authn/contracts';
import { join, normalize, resolve } from 'path';

import { AuthProvider, PasswordProvider, PrincipalAttributeProvider, RBAC_USER_MODEL, SimpleDbAuthProvider, User, UserIsBanned, UserNotActive, UserPrincipalFactory } from '../src/index.js';
import { TestConfiguration } from './common.test.js';
import { TEST_USER_UUID, TEST_USER_UUID_3 } from './migration/rbac.migration.js';
import { registerAuthzHost, rootAuthz } from './support/authz-host.js';

chai.use(chaiAsPromised);

function dir(path: string) {
  return resolve(normalize(join(process.cwd(), 'test', path)));
}

@Connection('default')
@Model('users')
class PrincipalAppUser extends User {}

type Derive = (user: User, principal: Principal) => Readonly<Record<string, unknown>>;
let firstDerive: Derive = () => ({});
let secondDerive: Derive = () => ({});

@Injectable(PrincipalAttributeProvider)
class FirstTestProvider extends PrincipalAttributeProvider {
  public async attributes(user: User, principal: Principal): Promise<Readonly<Record<string, unknown>>> {
    return firstDerive(user, principal);
  }
}

@Injectable(PrincipalAttributeProvider)
class SecondTestProvider extends PrincipalAttributeProvider {
  public async attributes(user: User, principal: Principal): Promise<Readonly<Record<string, unknown>>> {
    return secondDerive(user, principal);
  }
}

const sessionFacts: AuthnFacts = { method: 'password', strategy: 'local', assurance: 'aal1', mfa: [], authenticatedAt: new Date('2026-10-01T10:00:00Z'), sessionHandle: 'h-1' };
const tokenFacts: AuthnFacts = { method: 'token', strategy: 'token', assurance: 'aal1', mfa: [], authenticatedAt: new Date('2026-10-01T10:00:00Z') };

async function factory(): Promise<UserPrincipalFactory> {
  return (await DI.resolve(PrincipalFactory)) as UserPrincipalFactory;
}

describe('UserPrincipalFactory', function () {
  this.timeout(30000);

  before(() => {
    DI.register(SimpleDbAuthProvider).as(AuthProvider);
    DI.register(TestConfiguration).as(Configuration);
    DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
    DI.register(BasicPasswordProvider).as(PasswordProvider);
    registerAuthzHost();
    // referenced so the decorators register them
    void [FirstTestProvider, SecondTestProvider];
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
    firstDerive = () => ({});
    secondDerive = () => ({});
    sinon.restore();
    DI.clearCache();
  });

  it('is the PrincipalFactory authn resolves', async () => {
    expect(await factory()).to.be.instanceOf(UserPrincipalFactory);
  });

  describe('principalOf(identity, facts, extra)', () => {
    it('builds user:<Uuid> from a session login, with the user record, facts and ceiling', async () => {
      const ceiling = { roles: ['admin'] };

      const p = await (await factory()).principalOf({ type: 'user', id: TEST_USER_UUID }, sessionFacts, { ceiling });

      expect(p).to.include({ type: 'user', id: TEST_USER_UUID, authenticated: true, source: 'session' });
      expect(p.authn).to.eq(sessionFacts);
      expect(p.ceiling).to.eq(ceiling);
      expect(p.identity).to.be.instanceOf(User);
      expect((p.identity as User).Metadata['test:test'], 'metadata populated').to.eq('test');
      expect(p).to.not.have.property('onBehalfOf');
    });

    it("is a 'token' principal without a session handle, and keeps onBehalfOf and delegation", async () => {
      const owner = await (await factory()).principalOf({ type: 'user', id: TEST_USER_UUID }, sessionFacts, {});

      const p = await (await factory()).principalOf({ type: 'user', id: TEST_USER_UUID }, tokenFacts, { onBehalfOf: owner, delegation: 'inherit' });

      expect(p.source).to.eq('token');
      expect(p.onBehalfOf).to.eq(owner);
      expect(p.delegation).to.eq('inherit');
    });

    it('loads the user through the application user model, as SYSTEM', async () => {
      DI.register(PrincipalAppUser).asValue(RBAC_USER_MODEL, true);
      const runAs = sinon.spy(await rootAuthz(), 'runAs');

      const p = await (await factory()).principalOf({ type: 'user', id: TEST_USER_UUID }, sessionFacts, {});

      expect(p.identity).to.be.instanceOf(PrincipalAppUser);
      expect(runAs.calledOnce).to.eq(true);
      expect(runAs.firstCall.args.slice(0, 2)).to.deep.eq([SYSTEM, 'principal-factory']);
    });

    it('keeps strategy attributes, lets provider keys win, merges providers in registration order, and freezes the result', async () => {
      firstDerive = (u, p) => ({ pool: 'first', login: u.Login, seen: p.attributes.profile });
      secondDerive = () => ({ pool: 'second', profile: 'derived' });

      const p = await (await factory()).principalOf({ type: 'user', id: TEST_USER_UUID }, tokenFacts, { attributes: { profile: 'pinned', from: 'strategy' } });

      expect(p.attributes).to.deep.eq({ profile: 'derived', from: 'strategy', pool: 'second', login: 'test', seen: 'pinned' });
      expect(Object.isFrozen(p.attributes)).to.eq(true);
    });

    it('refuses an unknown user', async () => {
      await expect((await factory()).principalOf({ type: 'user', id: '2b9a51f4-8a52-4a33-9a2e-2d2f0c6f6a11' }, sessionFacts, {})).to.be.rejectedWith(ResourceNotFound);
    });

    it('refuses a soft-deleted user', async () => {
      const deleted = await User.query().withDeleted().whereLogin('test-deleted').firstOrFail();

      await expect((await factory()).principalOf({ type: 'user', id: deleted.Uuid }, sessionFacts, {})).to.be.rejectedWith(ResourceNotFound);
    });

    it('refuses an inactive user', async () => {
      const inactive = await User.query().whereLogin('test-notactive').firstOrFail();

      await expect((await factory()).principalOf({ type: 'user', id: inactive.Uuid }, sessionFacts, {})).to.be.rejectedWith(UserNotActive);
    });

    it('refuses a banned user', async () => {
      await expect((await factory()).principalOf({ type: 'user', id: TEST_USER_UUID_3 }, sessionFacts, {})).to.be.rejectedWith(UserIsBanned);
    });

    it('refuses an identity that is not a user', async () => {
      await expect((await factory()).principalOf({ type: 'service', id: 'telemetry' }, sessionFacts, {})).to.be.rejectedWith(InvalidArgument);
    });
  });

  describe('principalOf(user, opts)', () => {
    it("builds user:<Uuid> from a record in hand, source 'identity', no authn facts, attributes from providers", async () => {
      firstDerive = () => ({ pool: 'p1' });
      const user = await User.query().whereLogin('test').populate('Metadata').firstOrFail();
      const ceiling = { roles: ['user'] };

      const p = await (await factory()).principalOf(user, { ceiling });

      expect(p).to.include({ type: 'user', id: TEST_USER_UUID, authenticated: true, source: 'identity' });
      expect(p.identity).to.eq(user);
      expect(p.ceiling).to.eq(ceiling);
      expect(p).to.not.have.property('authn');
      expect(p.attributes).to.deep.eq({ pool: 'p1' });
    });

    it('refuses an inactive record', async () => {
      const inactive = await User.query().whereLogin('test-notactive').populate('Metadata').firstOrFail();

      await expect((await factory()).principalOf(inactive)).to.be.rejectedWith(UserNotActive);
    });
  });
});
