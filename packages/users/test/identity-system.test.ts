import { Configuration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import type { Class } from '@spinajs/di';
import { expect } from 'chai';
import * as sinon from 'sinon';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { DefaultQueueService } from '@spinajs/queue';
import { AuthzConfigError, AuthzContributor, ResourceAdapter, SYSTEM, UNATTENDED, currentPrincipal, runWithPrincipal } from '@spinajs/authz';
import type { Principal } from '@spinajs/authz';
import { QueryMiddleware } from '@spinajs/orm';
import type { AuthnEvent, AuthnEventType, IdentityRef } from '@spinajs/authn/contracts';

import { QueueAuthnEventSink, USER_COMMON_METADATA, User, UserAccountSink, UserActivated, UserIdentityStore, UserLogged, UserPasswordAgeSource, UserPasswordStore } from '../src/index.js';
import { TEST_USER_UUID } from './migration/rbac.migration.js';
import { rootAuthz } from './support/authz-host.js';
import { bootUsersDb, registerUsersTestHost, seedUser, storedUser } from './support/users-db.js';

type AuthzOrm = typeof import('@spinajs/authz-orm');

const HASH = '$argon2id$v=19$m=65536,t=3,p=4$c2FsdHNhbHQ$c3lzdGVtaGFzaA';
const OTHER = '$argon2id$v=19$m=65536,t=3,p=4$c2FsdHNhbHQ$b3RoZXJoYXNo';
const LAST = '$argon2id$v=19$m=65536,t=3,p=4$c2FsdHNhbHQ$bGFzdGhhc2g';
const AT = new Date('2026-10-05T08:30:00.000Z');

// authz-http's anonymous principal; users does not depend on authz-http.
const ANONYMOUS: Principal = Object.freeze({ type: 'anonymous', id: 'anonymous', authenticated: false, source: 'anonymous', attributes: Object.freeze({}) });

/** Login and reset callers: no principal in the store (UNATTENDED), and an anonymous request. */
const CALLERS: readonly [string, Principal | undefined][] = [
  ['UNATTENDED', undefined],
  ['anonymous', ANONYMOUS],
];

const as = <T>(caller: Principal | undefined, fn: () => Promise<T>): Promise<T> => (caller ? runWithPrincipal(caller, fn) : fn());

/** Runs `call` as `caller` and answers the ambient principal right after it: SYSTEM must not outlive a store call. */
const principalAfter = async (caller: Principal | undefined, call: () => Promise<unknown>): Promise<Principal> =>
  as(caller, async () => {
    await call();
    return currentPrincipal();
  });

const event = (type: AuthnEventType, identity: IdentityRef, over: Partial<AuthnEvent> = {}): AuthnEvent => ({ type, at: AT, outcome: 'success', identity, ...over });

describe('the identity stores over a user model that is an @AccessResource', function () {
  this.timeout(30000);

  let orm: AuthzOrm;
  let unregisterResource: (model: unknown) => void;
  let emit: sinon.SinonStub;
  /** The ambient principal of each queue emit, in order. */
  let emittedAs: Principal[];

  before(async () => {
    registerUsersTestHost();
    // Loaded here, not at the top: importing authz-orm registers its query middleware for every later suite.
    orm = await import('@spinajs/authz-orm');
    // The package's own module instance: its exports map hides the registry's test seam.
    ({ unregisterResource } = await import(pathToFileURL(join(process.cwd(), '..', 'authz-orm', 'lib', 'mjs', 'registry.js')).href));
  });

  beforeEach(async () => {
    await bootUsersDb();
    await rootAuthz();
    // The runtime guard throws only in the test env; the stores must pass it without the old scoping.
    (DI.get(Configuration) as Configuration).set(['process', 'env', 'APP_ENV'], 'test');
    emittedAs = [];
    emit = sinon.stub(DefaultQueueService.prototype, 'emit').callsFake(async () => {
      emittedAs.push(currentPrincipal());
      return undefined;
    });
  });

  afterEach(() => {
    unregisterResource(User);
    sinon.restore();
    DI.clearCache();
  });

  after(() => {
    // What the import registered (the package does not export these classes).
    for (const [service, name] of [
      [QueryMiddleware, 'AncestorMiddleware'],
      [QueryMiddleware, 'AccessGuardMiddleware'],
      [QueryMiddleware, 'AccessListMiddleware'],
      [ResourceAdapter, 'OrmResourceAdapter'],
      [AuthzContributor, 'AuthzOrmContributor'],
    ] as [Class<unknown>, string][]) {
      for (const type of DI.RootContainer.getRegisteredTypes(service).filter((t) => (t as Class<unknown>).name === name)) {
        DI.RootContainer.Registry.unregister(type);
      }
      DI.uncache(Array.ofType(service));
    }
  });

  /** As an application declares its user model; rows are seeded before, while nothing scopes `users`. */
  const scopeUsers = () => orm.registerAccessResource(User, 'user');

  it('an unwrapped lookup of a login caller is refused by the runtime guard', async () => {
    scopeUsers();

    for (const [name, caller] of CALLERS) {
      await expect(as(caller, () => User.query().withDeleted().where('Uuid', TEST_USER_UUID).first()), name).to.be.rejectedWith(AuthzConfigError);
    }
  });

  it('UserIdentityStore.findByLogin finds the account', async () => {
    scopeUsers();
    const store = new UserIdentityStore();

    for (const [name, caller] of CALLERS) {
      expect(await as(caller, () => store.findByLogin('test@spinajs.pl')), name).to.deep.eq({ type: 'user', id: TEST_USER_UUID });
      expect(await principalAfter(caller, () => store.findByLogin('test@spinajs.pl')), name).to.eq(caller ?? UNATTENDED);
    }
  });

  it('UserIdentityStore.status reads the row and its metadata', async () => {
    const { ref } = await seedUser({ login: 'scoped-status', active: false, invitePending: true });
    scopeUsers();
    const store = new UserIdentityStore();

    for (const [name, caller] of CALLERS) {
      expect(await as(caller, () => store.status(ref)), name).to.deep.eq({ exists: true, active: false, banned: false, deleted: false, invitePending: true });
      expect(await principalAfter(caller, () => store.status(ref)), name).to.eq(caller ?? UNATTENDED);
    }
  });

  it('UserIdentityStore.display reads the email and login', async () => {
    scopeUsers();
    const store = new UserIdentityStore();

    for (const [name, caller] of CALLERS) {
      expect(await as(caller, () => store.display({ type: 'user', id: TEST_USER_UUID })), name).to.deep.eq({ email: 'test@spinajs.pl', name: 'test' });
      expect(await principalAfter(caller, () => store.display({ type: 'user', id: TEST_USER_UUID })), name).to.eq(caller ?? UNATTENDED);
    }
  });

  it('UserPasswordStore.get reads the stored hash', async () => {
    const { ref } = await seedUser({ login: 'scoped-get', password: HASH });
    scopeUsers();
    const store = new UserPasswordStore();

    for (const [name, caller] of CALLERS) {
      expect(await as(caller, () => store.get(ref)), name).to.eq(HASH);
      expect(await principalAfter(caller, () => store.get(ref)), name).to.eq(caller ?? UNATTENDED);
    }
  });

  it('UserPasswordStore.set keeps its compare-and-set answers', async () => {
    const refs: IdentityRef[] = [];
    for (const [name] of CALLERS) {
      refs.push((await seedUser({ login: `scoped-set-${name}` })).ref);
    }
    scopeUsers();
    const store = new UserPasswordStore();

    for (const [i, [name, caller]] of CALLERS.entries()) {
      const ref = refs[i];
      await as(caller, async () => {
        expect(await store.set(ref, HASH, null), `${name}: null over no password`).to.eq(true);
        expect(await store.set(ref, OTHER, null), `${name}: null over a password`).to.eq(false);
        expect(await store.set(ref, HASH, HASH), `${name}: the stored value again`).to.eq(true);
        expect(await store.set(ref, OTHER, OTHER), `${name}: a stale expected value`).to.eq(false);
        expect(await store.set(ref, OTHER, HASH), `${name}: over the expected value`).to.eq(true);
        expect(await store.set(ref, LAST), `${name}: unconditional`).to.eq(true);
        expect(currentPrincipal(), name).to.eq(caller ?? UNATTENDED);
      });
    }

    unregisterResource(User);
    for (const ref of refs) {
      expect((await storedUser(ref.id)).Password).to.eq(LAST);
    }
  });

  it('UserPasswordAgeSource.passwordsSetBefore lists the aged passwords', async () => {
    const { ref } = await seedUser({ login: 'scoped-age', password: HASH });
    scopeUsers();
    const source = new UserPasswordAgeSource();

    for (const [name, caller] of CALLERS) {
      expect(await as(caller, () => source.passwordsSetBefore(new Date())), name).to.deep.include(ref);
      expect(await principalAfter(caller, () => source.passwordsSetBefore(new Date())), name).to.eq(caller ?? UNATTENDED);
    }
  });

  it('UserAccountSink records PasswordSetAt and activates an invited account', async () => {
    const { ref: reset } = await seedUser({ login: 'scoped-reset', password: HASH });
    const { ref: invited } = await seedUser({ login: 'scoped-invite', active: false, invitePending: true });
    scopeUsers();
    const sink = await DI.resolve(UserAccountSink);

    expect(await principalAfter(undefined, () => sink.publish(event('password.reset', reset)))).to.eq(UNATTENDED);
    expect(await principalAfter(ANONYMOUS, () => sink.publish(event('invite.redeem', invited)))).to.eq(ANONYMOUS);

    unregisterResource(User);
    expect((await storedUser(reset.id)).PasswordSetAt?.toMillis()).to.eq(AT.getTime());
    const u = await storedUser(invited.id);
    expect(Boolean(u.IsActive)).to.eq(true);
    expect(u.Metadata[USER_COMMON_METADATA.USER_INVITE_PENDING]).to.not.be.ok;
    expect(emit.args.map((a) => a[0]).some((e) => e instanceof UserActivated)).to.eq(true);
    // UserChanged and UserActivated go to queue subscribers as the anonymous redeemer, never as SYSTEM.
    expect(emittedAs).to.have.lengthOf(2);
    expect(emittedAs.every((p) => p === ANONYMOUS)).to.eq(true);
  });

  it('QueueAuthnEventSink reads the user of the event', async () => {
    scopeUsers();
    const sink = await DI.resolve(QueueAuthnEventSink);

    for (const [name, caller] of CALLERS) {
      expect(await principalAfter(caller, () => sink.publish(event('login', { type: 'user', id: TEST_USER_UUID }, { strategy: 'local' }))), name).to.eq(caller ?? UNATTENDED);
    }

    expect(emit.args.map((a) => a[0]).filter((e) => e instanceof UserLogged)).to.have.lengthOf(2);
    expect(emittedAs).to.have.lengthOf(2);
    expect(emittedAs[0]).to.eq(UNATTENDED);
    expect(emittedAs[1]).to.eq(ANONYMOUS);
    expect(emittedAs).to.not.include(SYSTEM);
  });
});
