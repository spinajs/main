import { BasicPasswordProvider } from '../src/password.js';
import { Bootstrapper, DI, Injectable } from '@spinajs/di';
import type { Class } from '@spinajs/di';
import { execFileSync } from 'child_process';
import chaiAsPromised from 'chai-as-promised';
import * as chai from 'chai';
import { expect } from 'chai';
import * as sinon from 'sinon';
import { Configuration } from '@spinajs/configuration';
import { InvalidArgument, ResourceNotFound } from '@spinajs/exceptions';
import { Connection, Model, Orm, QueryMiddleware } from '@spinajs/orm';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';
import { DefaultQueueService, Job, QueueJob, QueueMessageHook, QueueTrackingHook } from '@spinajs/queue';
import { AuthzContributor, ChangeBus, ResourceAdapter, SYSTEM, UNATTENDED, currentPrincipal, runWithPrincipal } from '@spinajs/authz';
import type { Principal } from '@spinajs/authz';
import { PrincipalFactory } from '@spinajs/authn/contracts';
import type { AuthnFacts } from '@spinajs/authn/contracts';
import { join, normalize, resolve } from 'path';

import { AuthProvider, PasswordProvider, PrincipalAttributeProvider, RBAC_USER_MODEL, SimpleDbAuthProvider, User, UserIsBanned, UserNotActive, UserPrincipalFactory } from '../src/index.js';
import { TestConfiguration } from './common.test.js';
import { TEST_USER_UUID, TEST_USER_UUID_3 } from './migration/rbac.migration.js';
import { registerAuthzHost, rootAuthz } from './support/authz-host.js';
import { seedUser, setIdentityFlags } from './support/users-db.js';

type AuthzQueue = typeof import('@spinajs/authz-queue');
type UsersQueue = typeof import('../src/queue/index.js');

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

    it('takes the source from opts, and the providers see it', async () => {
      firstDerive = (_u, principal) => ({ seen: principal.source });
      const user = await User.query().whereLogin('test').populate('Metadata').firstOrFail();

      const p = await (await factory()).principalOf(user, { source: 'queue' });

      expect(p.source).to.eq('queue');
      expect(p.attributes).to.deep.eq({ seen: 'queue' });
    });

    it('refuses an inactive record', async () => {
      const inactive = await User.query().whereLogin('test-notactive').populate('Metadata').firstOrFail();

      await expect((await factory()).principalOf(inactive)).to.be.rejectedWith(UserNotActive);
    });

    it('refuses a soft-deleted record', async () => {
      const deleted = await User.query().withDeleted().whereLogin('test-deleted').populate('Metadata').firstOrFail();

      await expect((await factory()).principalOf(deleted)).to.be.rejectedWith(ResourceNotFound);
    });

    it('refuses a banned record loaded without its metadata: the ban is read again', async () => {
      const banned = await User.query().whereUuid(TEST_USER_UUID_3).firstOrFail();
      expect(banned.IsBanned, 'without metadata the record itself cannot tell').to.eq(false);

      await expect((await factory()).principalOf(banned)).to.be.rejectedWith(UserIsBanned);
    });

    it('reloads a record without metadata as SYSTEM, and keeps a record with metadata as it is', async () => {
      const runAs = sinon.spy(await rootAuthz(), 'runAs');
      const bare = await User.query().whereLogin('test').firstOrFail();
      const full = await User.query().whereLogin('test').populate('Metadata').firstOrFail();

      const fromBare = await (await factory()).principalOf(bare);
      expect(runAs.calledOnce).to.eq(true);
      expect((fromBare.identity as User).Metadata['test:test']).to.eq('test');

      const fromFull = await (await factory()).principalOf(full);
      expect(runAs.calledOnce, 'no second lookup').to.eq(true);
      expect(fromFull.identity).to.eq(full);
    });
  });

  describe('UserInitiatorPrincipalFactory (@spinajs/users/queue)', () => {
    let authzQueue: AuthzQueue;
    let usersQueue: UsersQueue;
    let undo: () => void;

    // authz-queue registers its hooks, bus and job resource on import; nothing outside this block may see them.
    before(async () => {
      const added = trackRegistrations([QueueMessageHook, QueueTrackingHook, ChangeBus, 'InitiatorPrincipalFactory', QueryMiddleware, ResourceAdapter, AuthzContributor]);
      usersQueue = await import('../src/queue/index.js');
      authzQueue = await import('@spinajs/authz-queue');
      // The root domain of these tests has no queue to carry authz changes over.
      added.drop(ChangeBus);
      undo = () => added.dropAll();
    });

    after(() => undo());

    const seeded = async (login: string): Promise<string> => (await User.query().withDeleted().whereLogin(login).firstOrFail()).Uuid;
    const initiator = async (): Promise<InstanceType<AuthzQueue['InitiatorPrincipalFactory']>> => (await DI.resolve(authzQueue.InitiatorPrincipalFactory)) as InstanceType<AuthzQueue['InitiatorPrincipalFactory']>;

    it('is the InitiatorPrincipalFactory DI resolves once @spinajs/users/queue is imported', async () => {
      expect(await initiator()).to.be.instanceOf(usersQueue.UserInitiatorPrincipalFactory);
    });

    it("reloads an active user: provider attributes, the stamped ceiling revived, source 'queue'", async () => {
      firstDerive = (_u, principal) => ({ pool: 'p1', seen: principal.source });

      const p = await (await initiator()).principalOf({ type: 'user', id: TEST_USER_UUID, ceiling: { permissions: ['doc:read'], expiresAt: '2026-12-01T00:00:00.000Z' } as never });

      expect(p).to.include({ type: 'user', id: TEST_USER_UUID, authenticated: true, source: 'queue' });
      expect(p.attributes).to.deep.eq({ pool: 'p1', seen: 'queue' });
      expect(p.ceiling).to.deep.eq({ permissions: ['doc:read'], expiresAt: new Date('2026-12-01T00:00:00.000Z') });
      expect((p.identity as User).Uuid).to.eq(TEST_USER_UUID);
    });

    it('gives a user stamped without a ceiling none', async () => {
      const p = await (await initiator()).principalOf({ type: 'user', id: TEST_USER_UUID });

      expect(p).to.include({ type: 'user', id: TEST_USER_UUID, source: 'queue' });
      expect(p).to.not.have.property('ceiling');
    });

    for (const [title, uuid] of [
      ['an inactive', () => seeded('test-notactive')],
      ['a banned', async () => TEST_USER_UUID_3],
      ['a soft-deleted', () => seeded('test-deleted')],
      ['an unknown', async () => '00000000-0000-4000-8000-000000000000'],
    ] as const) {
      it(`runs ${title} user's job as UNATTENDED`, async () => {
        expect(await (await initiator()).principalOf({ type: 'user', id: await uuid() })).to.eq(UNATTENDED);
      });
    }

    for (const [title, stamp] of [
      ['a malformed ceiling', { type: 'user', id: TEST_USER_UUID, ceiling: { permissions: 'doc:read' } }],
      ['an empty id', { type: 'user', id: '' }],
      ['a numeric id', { type: 'user', id: 7 }],
      ['no stamp at all', null],
    ] as const) {
      it(`runs a job stamped with ${title} as UNATTENDED`, async () => {
        expect(await (await initiator()).principalOf(stamp as never)).to.eq(UNATTENDED);
      });
    }

    it('runs an agent as UNATTENDED: the stamp cannot name the owner to reload', async () => {
      expect(await (await initiator()).principalOf({ type: 'agent', id: 'agent-token-1' })).to.eq(UNATTENDED);
    });

    it('leaves system, unattended and service stamps to the stamped factory, without its warning', async () => {
      const warn = sinon.spy(console, 'warn');
      const f = await initiator();
      const ceiling = { permissions: ['doc:read'] };

      expect(await f.principalOf({ type: 'system', id: 'system' })).to.eq(SYSTEM);
      expect(await f.principalOf({ type: 'unattended', id: 'unattended' })).to.eq(UNATTENDED);
      expect(await f.principalOf({ type: 'service', id: 'svc', ceiling })).to.deep.eq({ type: 'service', id: 'svc', authenticated: true, source: 'queue', attributes: {}, ceiling });
      expect(warn.called, 'the stamped factory warns that users are not reloaded').to.eq(false);
    });

    it('throws when the user store fails, so the job is retried', async () => {
      const f = await initiator();
      await rootAuthz();
      sinon.stub(SqliteOrmDriver.prototype, 'executeOnDb').rejects(new Error('db down'));

      await expect(f.principalOf({ type: 'user', id: TEST_USER_UUID })).to.be.rejectedWith('db down');
    });

    it('throws when an attribute provider fails', async () => {
      firstDerive = () => {
        throw new Error('provider down');
      };

      await expect((await initiator()).principalOf({ type: 'user', id: TEST_USER_UUID })).to.be.rejectedWith('provider down');
    });

    it("through authz-queue's hook: a job queued by a user who is then deactivated runs as UNATTENDED", async () => {
      const { user, ref } = await seedUser({ login: 'queued-then-deactivated' });
      const hook = (await DI.resolve(authzQueue.AuthzQueueHook)) as InstanceType<AuthzQueue['AuthzQueueHook']>;
      const message = new InitiatorProbe();
      const asUser: Principal = { type: 'user', id: ref.id, authenticated: true, source: 'session', attributes: {} };

      await runWithPrincipal(asUser, () => hook.beforeEmit(message));
      expect(message.Initiator).to.deep.eq({ type: 'user', id: user.Uuid });
      const before = await hook.aroundHandle(message, async () => currentPrincipal());
      expect(before).to.include({ type: 'user', id: user.Uuid, source: 'queue' });

      await setIdentityFlags(ref, { active: false });

      expect(await hook.aroundHandle(message, async () => currentPrincipal())).to.eq(UNATTENDED);
    });

    it('importing @spinajs/users alone loads no part of authz-queue; @spinajs/users/queue does (built package)', () => {
      const script = [
        "import { DI } from '@spinajs/di';",
        "import { QueueMessageHook } from '@spinajs/queue';",
        "await import('@spinajs/users');",
        "const alone = { hook: DI.RootContainer.hasRegistered(QueueMessageHook), initiator: DI.RootContainer.hasRegistered('InitiatorPrincipalFactory') };",
        "const { UserInitiatorPrincipalFactory } = await import('@spinajs/users/queue');",
        "const { InitiatorPrincipalFactory } = await import('@spinajs/authz-queue');",
        'const resolved = (await DI.resolve(InitiatorPrincipalFactory)) instanceof UserInitiatorPrincipalFactory;',
        "console.log('RESULT ' + JSON.stringify({ alone, resolved, hook: DI.RootContainer.hasRegistered(QueueMessageHook) }));",
        'process.exit(0);',
      ].join('\n');

      const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], { cwd: process.cwd(), encoding: 'utf8', timeout: 60000 });

      const line = out.split(/\r?\n/).find((l) => l.startsWith('RESULT '));
      expect(JSON.parse(line!.slice('RESULT '.length))).to.deep.eq({ alone: { hook: false, initiator: false }, resolved: true, hook: true });
    });
  });
});

@Job({ runAs: 'initiator' })
class InitiatorProbe extends QueueJob {
  public async execute(): Promise<unknown> {
    return undefined;
  }
}

/** Registrations made from now on under `services`, to drop again; DI has no clean undo. */
function trackRegistrations(services: (Class<unknown> | string)[]): { drop(service: Class<unknown> | string): void; dropAll(): void } {
  const before = new Map(services.map((s) => [s, new Set(DI.RootContainer.getRegisteredTypes(s))]));
  const drop = (service: Class<unknown> | string): void => {
    for (const type of DI.RootContainer.getRegisteredTypes(service).filter((t) => !before.get(service)!.has(t))) {
      DI.RootContainer.Registry.unregister(type);
    }
    DI.uncache(service as never);
    if (typeof service !== 'string') DI.uncache(Array.ofType(service));
  };
  return { drop, dropAll: () => services.forEach(drop) };
}
