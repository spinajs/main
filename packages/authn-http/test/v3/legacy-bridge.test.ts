import 'mocha';
import { expect } from 'chai';
import { randomUUID } from 'node:crypto';
import { DateTime } from 'luxon';
import { Container, DI } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { AuthenticationFailed, Forbidden } from '@spinajs/exceptions';
import { BasePolicy, ServerMiddleware } from '@spinajs/http';
import type { IController, IRoute, Request } from '@spinajs/http';
import type { AuthnFacts, IdentityRef, Principal } from '@spinajs/authn/contracts';
import { DefaultSessionIssuer, MemorySessionStore } from '@spinajs/authn-session';

import * as barrel from '../../src/index.js';
import { AuthnMiddleware } from '../../src/middleware/authn.js';
import { AuthorizedPolicy } from '../../src/policies/AuthorizedPolicy.js';
import { LoggedPolicy } from '../../src/policies/LoggedPolicy.js';
import { RbacPolicy } from '../../src/policies/RbacPolicy.js';
import { Permission, Resource } from '../../src/decorators.js';

type Kind = 'none' | 'pending' | 'session' | 'impersonation' | 'token' | 'agent' | 'key' | 'service';

interface FakeUser {
  Uuid: string;
  Login: string;
}

interface Run {
  storage: Record<string, unknown>;
  /** Properties the bridge read off the request, and off req.storage. */
  reads: Set<string>;
  storageReads: Set<string>;
  storageWrites: string[];
  resTouched: Set<string>;
  error: unknown;
  warnings: string[];
}

@Resource('user')
class LegacyRoutes {
  @Permission(['readOwn'])
  public profile() {
    return null;
  }
}

const GUEST: FakeUser = Object.freeze({ Uuid: 'guest', Login: 'guest' });
const FACTS = (over: Partial<AuthnFacts> = {}): AuthnFacts => ({ method: 'password', strategy: 'local', assurance: 'aal1', mfa: [], authenticatedAt: new Date(), ...over });

/** What @spinajs/users registers under the two 2.x DI keys, as fakes: a user only for the uuids in `users`. */
function containerWith(users: Map<string, FakeUser> | null, guest: (() => FakeUser) | null = () => GUEST): IContainer {
  const c = new Container();
  if (users) {
    c.register(async (_c: IContainer, uuid: string) => {
      const user = users.get(uuid);
      if (!user) throw new Error(`no active user ${uuid}`);
      return user;
    }).as('RbacUserFactory');
  }
  if (guest) c.register(() => guest()).as('RbacGuestUserFactory');
  return c;
}

function bridgeIn(container: IContainer, warnings: string[]): ServerMiddleware {
  const Bridge = (barrel as unknown as { LegacyStorageBridge: new () => ServerMiddleware }).LegacyStorageBridge;
  const bridge = new Bridge();
  Object.defineProperty(bridge, 'Container', { value: container });
  Object.defineProperty(bridge, 'Log', { value: { warn: (m: string) => warnings.push(m), error: (m: string) => warnings.push(m), trace: () => undefined, info: () => undefined, debug: () => undefined } });
  return bridge;
}

/** Runs the bridge on a request whose every read and write is recorded. */
async function runBridge(container: IContainer, storage: Record<string, unknown>, extra: Record<string, unknown> = {}): Promise<Run> {
  const warnings: string[] = [];
  const reads = new Set<string>();
  const storageReads = new Set<string>();
  const storageWrites: string[] = [];
  const resTouched = new Set<string>();
  const store = new Proxy(storage, {
    get: (t, k) => (storageReads.add(String(k)), Reflect.get(t, k)),
    set: (t, k, v) => (storageWrites.push(String(k)), Reflect.set(t, k, v)),
  });
  const req = new Proxy({ storage: store, ...extra }, { get: (t, k) => (reads.add(String(k)), Reflect.get(t, k)) });
  const res = new Proxy({}, { get: (_t, k) => (resTouched.add(String(k)), () => undefined) });
  const handler = bridgeIn(container, warnings).before()!;
  const error = await new Promise<unknown>((resolve) => handler(req as unknown as Request, res as never, (e?: unknown) => resolve(e)));
  return { storage, reads, storageReads, storageWrites, resTouched, error, warnings };
}

const route = { Method: 'profile' } as unknown as IRoute;

async function outcome(policy: BasePolicy, storage: Record<string, unknown>, instance: IController = {} as IController): Promise<string> {
  try {
    await policy.execute({ storage } as unknown as Request, route, instance);
    return 'pass';
  } catch (e) {
    if (e instanceof Forbidden) return '403';
    if (e instanceof AuthenticationFailed) return '401';
    throw e;
  }
}

describe('LegacyStorageBridge: the 2.x storage keys from req.storage.AuthnPrincipal (N8c-D3)', function () {
  this.timeout(30000);

  let issuer: DefaultSessionIssuer;
  let alice: IdentityRef;
  let bob: IdentityRef;
  let users: Map<string, FakeUser>;

  /** req.storage as AuthnMiddleware leaves it for each principal kind; session kinds hold a real issued session of alice. */
  async function storageOf(kind: Kind, o: { impersonator?: IdentityRef; attributes?: Record<string, unknown>; ownerAttributes?: Record<string, unknown> } = {}): Promise<Record<string, unknown>> {
    const storage: Record<string, unknown> = { AuthnPrincipal: null, AuthnSession: null, ClientIp: '203.0.113.7' };
    const perRequest = (type: string, id: string, authn: Partial<AuthnFacts>, extra: Partial<Principal> = {}): Principal => ({ type, id, authenticated: true, source: 'token', attributes: {}, authn: FACTS(authn), ...extra });
    if (kind === 'pending' || kind === 'session' || kind === 'impersonation') {
      const facts = FACTS(kind === 'impersonation' ? { impersonator: o.impersonator ?? bob } : {});
      const h = await issuer.issue(alice, facts, kind === 'pending' ? { pending: { steps: ['totp'] } } : undefined);
      const restored = (await issuer.restore(h.id))!;
      storage.AuthnSession = restored;
      if (kind !== 'pending') storage.AuthnPrincipal = { type: alice.type, id: alice.id, authenticated: true, source: 'session', attributes: {}, authn: restored.facts } satisfies Principal;
    }
    if (kind === 'token') storage.AuthnPrincipal = perRequest(alice.type, alice.id, { method: 'token', strategy: 'token' }, o.attributes ? { attributes: o.attributes } : {});
    if (kind === 'agent') {
      const owner = perRequest(alice.type, alice.id, { method: 'token', strategy: 'token' }, o.ownerAttributes ? { attributes: o.ownerAttributes } : {});
      storage.AuthnPrincipal = perRequest('agent', 'agent-1', { method: 'token', strategy: 'token' }, { onBehalfOf: owner, delegation: 'inherit', ceiling: { reason: 'out_of_scope' }, ...(o.attributes ? { attributes: o.attributes } : {}) });
    }
    if (kind === 'key') storage.AuthnPrincipal = perRequest(alice.type, alice.id, { method: 'jws', strategy: 'keys' });
    if (kind === 'service') storage.AuthnPrincipal = perRequest('service', 'billing', { method: 'jws', strategy: 'keys' });
    return storage;
  }

  before(() => {
    const store = new MemorySessionStore();
    const sixty = () => DateTime.now().plus({ minutes: 60 });
    Object.defineProperty(store, 'Expiration', { value: { initial: sixty, renew: sixty } });
    issuer = new DefaultSessionIssuer();
    Object.defineProperty(issuer, 'Store', { value: store });
    Object.defineProperty(issuer, 'PendingTtlSeconds', { value: 300 });
  });

  beforeEach(() => {
    alice = { type: 'user', id: randomUUID() };
    bob = { type: 'user', id: randomUUID() };
    users = new Map([
      [alice.id, { Uuid: alice.id, Login: 'alice' }],
      [bob.id, { Uuid: bob.id, Login: 'bob' }],
    ]);
  });

  describe('wiring', () => {
    it('is exported from the barrel, also under the deprecated RbacMiddleware name, and registered once as a root ServerMiddleware', () => {
      const b = barrel as unknown as Record<string, unknown>;
      expect(b.LegacyStorageBridge, 'LegacyStorageBridge').to.be.a('function');
      expect((b.LegacyStorageBridge as { name: string }).name).to.eq('LegacyStorageBridge');
      expect(b.RbacMiddleware).to.eq(b.LegacyStorageBridge);
      expect((DI.getRegisteredTypes(ServerMiddleware) ?? []).filter((t) => t === b.LegacyStorageBridge)).to.have.length(1);
    });

    it('runs after AuthnMiddleware (Order 6 > 5)', () => {
      const Bridge = (barrel as unknown as { LegacyStorageBridge: new () => ServerMiddleware }).LegacyStorageBridge;
      expect(new Bridge().Order).to.eq(6);
      expect(new Bridge().Order).to.be.greaterThan(new AuthnMiddleware().Order);
    });
  });

  describe('no principal: the 2.x guest, so users ORM checks still see a User', () => {
    it('anonymous: User is the guest; nothing else is set', async () => {
      const r = await runBridge(containerWith(users), await storageOf('none'));
      expect(r.error).to.eq(undefined);
      expect(r.storage.User).to.eq(GUEST);
      expect(r.storageWrites).to.deep.eq(['User']);
    });

    it('SR-07 pending session: the guest, not the session user', async () => {
      const r = await runBridge(containerWith(users), await storageOf('pending'));
      expect(r.storage.User).to.eq(GUEST);
      expect(r.storageWrites).to.deep.eq(['User']);
    });

    it('a principal that is not authenticated counts as none', async () => {
      const storage = { AuthnPrincipal: { type: 'user', id: alice.id, authenticated: false, source: 'link', attributes: {} } };
      const r = await runBridge(containerWith(users), storage);
      expect(r.storage.User).to.eq(GUEST);
      expect(r.storageWrites).to.deep.eq(['User']);
    });

    it('a request carrying only a 2.x ssid cookie (and a bearer header) gets the guest: the bridge reads no cookie and no header', async () => {
      const r = await runBridge(containerWith(users), await storageOf('none'), {
        cookies: { ssid: 's:2x-session', '__Host-ssid': '2x-session' },
        signedCookies: { ssid: '2x-session' },
        headers: { cookie: 'ssid=s%3A2x-session', authorization: 'Bearer spt_2x' },
      });
      expect(r.storage.User).to.eq(GUEST);
      expect([...r.reads]).to.deep.eq(['storage']);
    });

    it('without users (no RbacGuestUserFactory) it leaves User unset', async () => {
      const r = await runBridge(containerWith(null, null), await storageOf('none'));
      expect(r.error).to.eq(undefined);
      expect(r.storageWrites).to.deep.eq([]);
    });

    it('a guest factory that throws fails the request instead of leaving the ORM checks without a User', async () => {
      const r = await runBridge(
        containerWith(users, () => {
          throw new Error('guest down');
        }),
        await storageOf('none'),
      );
      expect(r.error).to.be.instanceOf(Error);
      expect(r.storageWrites).to.deep.eq([]);
    });
  });

  describe('a user principal', () => {
    it('a session: User from RbacUserFactory by the principal id; no Session, no ActiveRole, no TokenAuth', async () => {
      const r = await runBridge(containerWith(users), await storageOf('session'));
      expect(r.storage.User).to.eq(users.get(alice.id));
      expect(r.storageWrites).to.deep.eq(['User']);
    });

    it('a user the factory cannot load (inactive or missing) gets the guest and a warning', async () => {
      users.delete(alice.id);
      const r = await runBridge(containerWith(users), await storageOf('session'));
      expect(r.error).to.eq(undefined);
      expect(r.storage.User).to.eq(GUEST);
      expect(r.warnings).to.have.length(1);
    });

    it('without users (no RbacUserFactory) it leaves User unset', async () => {
      const r = await runBridge(containerWith(null, null), await storageOf('session'));
      expect(r.storageWrites).to.deep.eq([]);
    });

    it('an impersonation: User is the target, Impersonator the impersonator, both through the factory', async () => {
      const r = await runBridge(containerWith(users), await storageOf('impersonation'));
      expect(r.storage.User).to.eq(users.get(alice.id));
      expect(r.storage.Impersonator).to.eq(users.get(bob.id));
      expect(r.storageWrites).to.have.members(['User', 'Impersonator']);
    });

    it('an impersonation whose impersonator the factory cannot load still sets a truthy Impersonator', async () => {
      users.delete(bob.id);
      const r = await runBridge(containerWith(users), await storageOf('impersonation'));
      expect(r.storage.User).to.eq(users.get(alice.id));
      expect(r.storage.Impersonator).to.be.an('object');
      expect(r.storage.Impersonator).to.not.eq(GUEST);
      expect(r.warnings).to.have.length(1);
    });

    it('an impersonation without users still sets a truthy Impersonator', async () => {
      const r = await runBridge(containerWith(null, null), await storageOf('impersonation'));
      expect(r.storage.Impersonator).to.be.an('object');
    });
  });

  describe('a per-request principal (token, agent, key, service): TokenAuth is set', () => {
    for (const kind of ['token', 'key'] as const) {
      it(`${kind}: User is the owner, TokenAuth a truthy marker`, async () => {
        const r = await runBridge(containerWith(users), await storageOf(kind));
        expect(r.storage.User).to.eq(users.get(alice.id));
        expect(r.storage.TokenAuth).to.be.an('object');
        expect(r.storageWrites).to.have.members(['User', 'TokenAuth']);
      });
    }

    it('agent: User is the user it acts on behalf of', async () => {
      const r = await runBridge(containerWith(users), await storageOf('agent'));
      expect(r.storage.User).to.eq(users.get(alice.id));
      expect(r.storage.TokenAuth).to.be.an('object');
    });

    it('service: no user owner, so the guest, and TokenAuth', async () => {
      const r = await runBridge(containerWith(users), await storageOf('service'));
      expect(r.storage.User).to.eq(GUEST);
      expect(r.storage.TokenAuth).to.be.an('object');
    });

    it('a token pinned to a profile: TokenAuth carries it (TokenStrategy sets principal.attributes.profile)', async () => {
      const r = await runBridge(containerWith(users), await storageOf('token', { attributes: { profile: 'editor' } }));
      expect(r.storage.TokenAuth).to.deep.eq({ Uuid: '', Profile: 'editor' });
      expect(Object.isFrozen(r.storage.TokenAuth)).to.eq(true);
    });

    it('a token without a usable profile: TokenAuth has no Profile', async () => {
      for (const attributes of [{}, { profile: '' }, { profile: 42 }, { profile: ['editor'] }]) {
        const r = await runBridge(containerWith(users), await storageOf('token', { attributes }));
        expect(r.storage.TokenAuth, JSON.stringify(attributes)).to.deep.eq({ Uuid: '' });
      }
    });

    it("agent (TokenStrategy): TokenAuth.Uuid is the agent's id, its access token's id; the profile is read off the agent, never off onBehalfOf", async () => {
      const r = await runBridge(containerWith(users), await storageOf('agent', { ownerAttributes: { profile: 'owner-attribute' } }));
      expect(r.storage.TokenAuth).to.deep.eq({ Uuid: 'agent-1' });
      const pinned = await runBridge(containerWith(users), await storageOf('agent', { attributes: { profile: 'editor' } }));
      expect(pinned.storage.TokenAuth).to.deep.eq({ Uuid: 'agent-1', Profile: 'editor' });
    });

    it('key, service and an agent not authenticated by a token name no token row: Uuid stays empty', async () => {
      for (const kind of ['key', 'service'] as const) {
        const r = await runBridge(containerWith(users), await storageOf(kind));
        expect(r.storage.TokenAuth, kind).to.deep.eq({ Uuid: '' });
      }
      const storage = await storageOf('agent');
      const agent = storage.AuthnPrincipal as Principal;
      storage.AuthnPrincipal = { ...agent, authn: FACTS({ method: 'jws', strategy: 'keys' }) };
      expect((await runBridge(containerWith(users), storage)).storage.TokenAuth).to.deep.eq({ Uuid: '' });
    });

    it('without users TokenAuth is still set', async () => {
      const r = await runBridge(containerWith(null, null), await storageOf('token'));
      expect(r.storageWrites).to.deep.eq(['TokenAuth']);
    });
  });

  describe('what it never does', () => {
    const KINDS: readonly Kind[] = ['none', 'pending', 'session', 'impersonation', 'token', 'agent', 'key', 'service'];

    it('reads only req.storage.AuthnPrincipal and AuthnSession; writes only User, Impersonator, TokenAuth; never ActiveRole or Session; touches no response header', async () => {
      for (const kind of KINDS) {
        const r = await runBridge(containerWith(users), await storageOf(kind));
        expect([...r.reads], kind).to.deep.eq(['storage']);
        expect(
          [...r.storageReads].filter((k) => !['AuthnPrincipal', 'AuthnSession'].includes(k)),
          kind,
        ).to.deep.eq([]);
        expect(
          r.storageWrites.filter((k) => !['User', 'Impersonator', 'TokenAuth'].includes(k)),
          kind,
        ).to.deep.eq([]);
        expect(r.storage, kind).to.not.have.any.keys('ActiveRole', 'Session');
        expect([...r.resTouched], kind).to.deep.eq([]);
      }
    });
  });

  describe('the 2.x policies over what the bridge writes (fail closed)', () => {
    async function bridged(kind: Kind, users_: Map<string, FakeUser> = users): Promise<Record<string, unknown>> {
      return (await runBridge(containerWith(users_), await storageOf(kind))).storage;
    }

    it('2.x AuthorizedPolicy, LoggedPolicy and RbacPolicy (@Permission) refuse an active 3.0 session: no 2.x Session', async () => {
      for (const kind of ['session', 'impersonation', 'token', 'none'] as const) {
        const storage = await bridged(kind);
        expect(await outcome(new AuthorizedPolicy(), storage), `AuthorizedPolicy ${kind}`).to.eq('401');
        expect(await outcome(new LoggedPolicy(), storage), `LoggedPolicy ${kind}`).to.eq('401');
        expect(await outcome(new RbacPolicy(), storage, new LegacyRoutes() as unknown as IController), `RbacPolicy ${kind}`).to.eq('401');
      }
    });
  });
});
