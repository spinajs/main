import 'mocha';
import { expect } from 'chai';
import { randomBytes, randomUUID } from 'node:crypto';
import express from 'express';
import cookieParser from 'cookie-parser';
import * as cs from 'cookie-signature';
import { DateTime } from 'luxon';
import { Bootstrapper, DI } from '@spinajs/di';
import type { Class, IContainer } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { AuthenticationFailed, Forbidden } from '@spinajs/exceptions';
import { Orm } from '@spinajs/orm';
import { BaseController, BasePolicy, Controllers, HttpServer, ServerMiddleware } from '@spinajs/http';
import type { IController, IRoute, IRouteParameter, Request } from '@spinajs/http';
import { fsService } from '@spinajs/fs';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';
import { AuthProvider, BasicPasswordProvider, PasswordProvider, SimpleDbAuthProvider } from '@spinajs/users';
import { AuthenticationStrategy, AuthnEventSink, AuthnThrottle, IMPERSONATION_BLOCK, IdentityStore, ImpersonationGuard, MfaPolicy, PasswordCredentialStore, PrincipalFactory, SessionIssuer } from '@spinajs/authn';
import type { AuthnFacts, IdentityRef, Principal, StrategyOutcome } from '@spinajs/authn';
import { DefaultSessionIssuer, MemorySessionStore, appEnvOf, sessionCookieName } from '@spinajs/authn-session';
import type { ISessionCookieConfig } from '@spinajs/authn-session';
import { EnrolledMfaPolicy, FakeIdentityStore, FakeImpersonationGuard, FakeMfaStep, FakeStrategy, MemoryPasswordCredentialStore, RecordingEventSink, RecordingPrincipalFactory, RecordingThrottle, fakeHash } from '@spinajs/authn-testing';

import * as api from '../../src/api.js';
import * as barrel from '../../src/index.js';
import * as v3 from '../../src/v3/index.js';
import { AuthnMiddleware } from '../../src/middleware/authn.js';
import { NotLoggedPolicy as MovedNotLoggedPolicy } from '../../src/policies/NotLoggedPolicy.js';
import { NoTokenAuthPolicy as MovedNoTokenAuthPolicy } from '../../src/token/policies/NoTokenAuthPolicy.js';
import { NoImpersonationPolicy as MovedNoImpersonationPolicy } from '../../src/token/policies/NoImpersonationPolicy.js';
import { AuthnIdentityArg, AuthnSessionArg, AuthnSessionDataArg, AuthnSessionIdArg } from '../../src/args/authn.js';
import { registerAuthnHttpV3 } from '../../src/v3/register.js';
import { POLICY_PROBE_PATH, usePolicyContainer } from './policy-probe.js';
import { APP_ORIGIN, COOKIE_SECRET, TestConfiguration, req as http, restoreHttpErrorMap } from '../token-common.js';

const { Authenticated, FreshAuth, MfaSatisfied, NoSession, NotLoggedPolicy, NoTokenAuthPolicy, NoImpersonationPolicy } = v3;

const ALICE_PASSWORD = 'Alice-Pass-1234';
const BOB_PASSWORD = 'Bob-Pass-2345x';

class PolicySuiteConfiguration extends TestConfiguration {
  protected onLoad(): unknown {
    const base = super.onLoad() as { http: Record<string, unknown>; authn: Record<string, unknown> };
    return {
      ...base,
      http: { ...base.http, middlewares: [express.json({ limit: '5mb' }), express.urlencoded({ extended: true }), cookieParser(COOKIE_SECRET)] },
      authn: {
        ...base.authn,
        strategies: [
          { name: 'local', service: 'PolicySuitePasswordStrategy' },
          { name: 'token', service: 'PolicySuiteTokenStrategy' },
        ],
        mfa: { policy: { service: 'PolicySuiteMfaPolicy' } },
        freshAuth: { maxAgeSeconds: 300 },
      },
    };
  }
}

// Inert outside this suite (see AuthnMiddlewareUnderTest in authn-middleware.test.ts for the same pattern).
let suiteChild: IContainer | null = null;

class PolicySuiteAuthnMiddleware extends AuthnMiddleware {
  public async resolve(): Promise<void> {
    if (!suiteChild) return;
    this.Container = suiteChild;
    await super.resolve();
  }

  public before() {
    return suiteChild ? super.before() : null;
  }
}

async function releaseHttpServer(): Promise<void> {
  await DI.get(HttpServer)?.stop();
  DI.uncache(HttpServer);
  DI.uncache(Controllers);
  for (const type of DI.getRegisteredTypes(BaseController) ?? []) DI.uncache(type as Class<BaseController>);
  DI.uncache(BaseController);
}

function bind(child: IContainer, base: Class<unknown>, name: string, value: unknown): void {
  const factory = { [name]: () => value }[name];
  child.register(factory).as(base);
}

interface Suite {
  child: IContainer;
  identities: FakeIdentityStore;
  passwords: MemoryPasswordCredentialStore;
  issuer: DefaultSessionIssuer;
  throttle: RecordingThrottle;
  step: FakeMfaStep;
  tokens: Map<string, StrategyOutcome>;
  passwordStrategy: FakeStrategy;
  events: RecordingEventSink;
}

async function buildSuite(): Promise<Suite> {
  const child = DI.RootContainer.child();
  const identities = new FakeIdentityStore();
  const passwords = new MemoryPasswordCredentialStore();
  const store = new MemorySessionStore();
  const sixty = () => DateTime.now().plus({ minutes: 60 });
  Object.defineProperty(store, 'Expiration', { value: { initial: sixty, renew: sixty } });
  const issuer = new DefaultSessionIssuer();
  // Built by hand around this suite's own store (fixed 60-minute expiry), not the configured one.
  Object.defineProperty(issuer, 'Store', { value: store });
  Object.defineProperty(issuer, 'PendingTtlSeconds', { value: 300 });
  const throttle = new RecordingThrottle();
  const events = new RecordingEventSink();
  const step = new FakeMfaStep({ name: 'totp' });
  const tokens = new Map<string, StrategyOutcome>();
  const passwordStrategy = FakeStrategy.password({ identities, passwords, name: 'local' });
  const tokenStrategy = new FakeStrategy({
    name: 'token',
    kinds: ['bearer'],
    interactive: false,
    keys: () => [{ kind: 'account', value: 'token' }],
    verify: async (c) => (c.kind === 'bearer' ? (tokens.get(String(c.token)) ?? { ok: false, reason: 'invalid_credentials' }) : { ok: false, reason: 'unsupported_credentials' }),
  });

  bind(child, IdentityStore, 'PolicySuiteIdentityStore', identities);
  bind(child, PasswordCredentialStore, 'PolicySuitePasswordStore', passwords);
  bind(child, PrincipalFactory, 'PolicySuitePrincipalFactory', new RecordingPrincipalFactory());
  bind(child, ImpersonationGuard, 'PolicySuiteImpersonationGuard', new FakeImpersonationGuard());
  bind(child, SessionIssuer, 'PolicySuiteSessionIssuer', issuer);
  bind(child, AuthnThrottle, 'MemoryAuthnThrottle', throttle);
  bind(child, AuthenticationStrategy, 'PolicySuitePasswordStrategy', passwordStrategy);
  bind(child, AuthenticationStrategy, 'PolicySuiteTokenStrategy', tokenStrategy);
  bind(child, MfaPolicy, 'PolicySuiteMfaPolicy', new EnrolledMfaPolicy([step]));
  // Before anything resolves the child's AuthnAudit, which reads its sinks once.
  bind(child, AuthnEventSink, 'PolicySuiteEventSink', events);
  await registerAuthnHttpV3(child);
  return { child, identities, passwords, issuer, throttle, step, tokens, passwordStrategy, events };
}

const FACTS = (over: Partial<AuthnFacts> = {}): AuthnFacts => ({ method: 'password', strategy: 'local', assurance: 'aal1', mfa: [], authenticatedAt: new Date(), ...over });
const secondsAgo = (s: number) => new Date(Date.now() - s * 1000);

type Kind = 'none' | 'pending' | 'session' | 'impersonation' | 'token' | 'agent' | 'key';
const KINDS: readonly Kind[] = ['none', 'pending', 'session', 'impersonation', 'token', 'agent', 'key'];

const route = { Method: 'probe' } as unknown as IRoute;
const controller = {} as IController;

/** 'pass', or '<status> <error code>' of the refusal. */
async function outcome(run: Promise<void>): Promise<string> {
  try {
    await run;
    return 'pass';
  } catch (e) {
    const error = (e as { error?: unknown }).error;
    const code = typeof error === 'string' ? error : (error as { code?: string } | undefined)?.code;
    if (e instanceof Forbidden) return `403 ${code}`;
    if (e instanceof AuthenticationFailed) return `401 ${code}`;
    throw e;
  }
}

describe('3.0 authn policies and route args', function () {
  this.timeout(60000);

  let s: Suite;
  let cookieName: string;
  let alice: IdentityRef;
  let bob: IdentityRef;

  const cookieOf = (rawId: string) => `${cookieName}=${encodeURIComponent(cs.sign(rawId, COOKIE_SECRET))}`;

  /** A request as AuthnMiddleware leaves it, for each principal kind; session kinds hold a real issued session of alice. */
  async function requestOf(kind: Kind, o: { facts?: Partial<AuthnFacts>; body?: unknown } = {}): Promise<Request> {
    const storage: Record<string, unknown> = { AuthnPrincipal: null, AuthnSession: null, ClientIp: '203.0.113.7' };
    const perRequest = (type: string, id: string, authn: Partial<AuthnFacts>, extra: Partial<Principal> = {}): Principal => ({ type, id, authenticated: true, source: 'token', attributes: {}, authn: { ...FACTS(), ...authn }, ...extra });
    if (kind === 'pending' || kind === 'session' || kind === 'impersonation') {
      const facts = FACTS({ ...(kind === 'impersonation' ? { impersonator: bob } : {}), ...o.facts });
      const h = await s.issuer.issue(alice, facts, kind === 'pending' ? { pending: { steps: ['totp'] } } : undefined);
      if (kind === 'impersonation') await s.issuer.set(h, IMPERSONATION_BLOCK, { startedAt: new Date().toISOString() });
      const restored = (await s.issuer.restore(h.id))!;
      storage.AuthnSession = restored;
      if (kind !== 'pending') storage.AuthnPrincipal = { type: alice.type, id: alice.id, authenticated: true, source: 'session', attributes: {}, authn: restored.facts } satisfies Principal;
    }
    if (kind === 'token') storage.AuthnPrincipal = perRequest(alice.type, alice.id, { method: 'token', strategy: 'token', ...o.facts });
    if (kind === 'agent') {
      const owner = perRequest(alice.type, alice.id, { method: 'token', strategy: 'token' });
      storage.AuthnPrincipal = perRequest('agent', 'agent-1', { method: 'token', strategy: 'token', ...o.facts }, { onBehalfOf: owner, delegation: 'inherit', ceiling: { reason: 'out_of_scope' } });
    }
    if (kind === 'key') storage.AuthnPrincipal = perRequest(alice.type, alice.id, { method: 'jws', strategy: 'keys', ...o.facts });
    return { storage, body: o.body, headers: { 'user-agent': 'policy-suite' } } as unknown as Request;
  }

  async function run(policy: BasePolicy, req: Request): Promise<string> {
    expect(policy.isEnabled(route, controller)).to.eq(true);
    return outcome(policy.execute(req, route, controller));
  }

  const resolve = <T>(type: Class<T>, options?: unknown[]): T => s.child.resolve(type, options) as T;

  async function startServer(): Promise<void> {
    DI.uncache(PolicySuiteAuthnMiddleware);
    DI.uncache(barrel.CsrfOriginGuard);
    DI.uncache(barrel.ClientIp);
    DI.uncache(ServerMiddleware);
    await DI.resolve(Controllers);
    await (await DI.resolve(HttpServer)).start();
  }

  before(async () => {
    DI.setESMModuleSupport();
    restoreHttpErrorMap();

    DI.unregister(PolicySuiteConfiguration);
    DI.register(PolicySuiteConfiguration).as(Configuration);
    DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
    DI.register(BasicPasswordProvider).as(PasswordProvider);
    DI.register(SimpleDbAuthProvider).as(AuthProvider);
    DI.register(PolicySuiteAuthnMiddleware).as(ServerMiddleware);

    const bootstrappers = await DI.resolve(Array.ofType(Bootstrapper));
    for (const b of bootstrappers) await b.bootstrap();

    const config = await DI.resolve(Configuration);
    await DI.resolve(fsService);
    await DI.resolve(Orm);

    s = await buildSuite();
    suiteChild = s.child;
    usePolicyContainer(s.child);
    cookieName = sessionCookieName(config.get<ISessionCookieConfig>('authn.session.cookie', {}), appEnvOf(config));
    await startServer();
  });

  beforeEach(async () => {
    alice = s.identities.add({ login: `alice-${randomUUID()}`, email: `alice-${randomUUID()}@example.test` });
    bob = s.identities.add({ login: `bob-${randomUUID()}`, email: `bob-${randomUUID()}@example.test` });
    await s.passwords.set(alice, fakeHash(ALICE_PASSWORD));
    await s.passwords.set(bob, fakeHash(BOB_PASSWORD));
    s.throttle.attempts.length = 0;
    s.throttle.succeeds.length = 0;
    s.passwordStrategy.verifyCalls.length = 0;
  });

  after(async () => {
    await releaseHttpServer();
    suiteChild = null;
    usePolicyContainer(null);
    DI.uncache(PolicySuiteAuthnMiddleware);
    DI.uncache(barrel.CsrfOriginGuard);
    DI.uncache(barrel.ClientIp);
    DI.uncache(ServerMiddleware);
    await s?.child.dispose();
    DI.unregister(PolicySuiteConfiguration);
    DI.uncache(PolicySuiteConfiguration);
    DI.uncache(Configuration);
    DI.uncache(Orm);
  });

  describe('exports', () => {
    it('the barrel shadows the api.ts names no 2.x consumer uses; the five 2.x names stay until N8c', () => {
      for (const n of ['Authenticated', 'FreshAuth', 'MfaSatisfied', 'NoSession', 'Identity', 'AuthnSession'] as const) {
        expect(barrel[n], n).to.eq(v3[n]).and.not.eq(api[n]);
      }
      for (const n of ['NotLoggedPolicy', 'NoTokenAuthPolicy', 'NoImpersonationPolicy', 'FromSession', 'SessionId'] as const) {
        expect(barrel[n], n).to.not.eq(v3[n]).and.not.eq(api[n]);
      }
    });

    it('N8a-D2: a 2.x policy and the 3.0 one of the same name each resolve to their own class, in either order', () => {
      for (const [old, lane] of [
        [MovedNotLoggedPolicy, NotLoggedPolicy],
        [MovedNoTokenAuthPolicy, NoTokenAuthPolicy],
        [MovedNoImpersonationPolicy, NoImpersonationPolicy],
      ] as const) {
        expect(old.name).to.eq(lane.name);
        expect(DI.resolve(old as Class<unknown>), old.name).to.be.instanceOf(old);
        expect(DI.resolve(lane as Class<unknown>), lane.name).to.be.instanceOf(lane);
        expect(DI.resolve(old as Class<unknown>), old.name).to.be.instanceOf(old);
      }
    });

    it('every policy extends BasePolicy', () => {
      for (const P of [Authenticated, FreshAuth, MfaSatisfied, NoSession, NotLoggedPolicy, NoTokenAuthPolicy, NoImpersonationPolicy]) expect(Object.getPrototypeOf(P), P.name).to.eq(BasePolicy);
    });
  });

  describe('policies over each principal kind', () => {
    const MATRIX: Record<string, Record<Kind, string>> = {
      Authenticated: { none: '401 unauthenticated', pending: '401 unauthenticated', session: 'pass', impersonation: 'pass', token: 'pass', agent: 'pass', key: 'pass' },
      NoSession: { none: 'pass', pending: '403 session_exists', session: '403 session_exists', impersonation: '403 session_exists', token: 'pass', agent: 'pass', key: 'pass' },
      NotLoggedPolicy: { none: 'pass', pending: 'pass', session: '403 already_authenticated', impersonation: '403 already_authenticated', token: '403 already_authenticated', agent: '403 already_authenticated', key: '403 already_authenticated' },
      NoTokenAuthPolicy: { none: 'pass', pending: 'pass', session: 'pass', impersonation: 'pass', token: '403 session_required', agent: '403 session_required', key: '403 session_required' },
      NoImpersonationPolicy: { none: 'pass', pending: 'pass', session: 'pass', impersonation: '403 impersonating', token: 'pass', agent: 'pass', key: 'pass' },
      // Fresh facts: only the session principal passes.
      FreshAuth: { none: '401 unauthenticated', pending: '401 unauthenticated', session: 'pass', impersonation: '403 impersonating', token: '403 session_required', agent: '403 session_required', key: '403 session_required' },
      // alice is enrolled in totp and every session kind is aal1; EnrolledMfaPolicy requires steps for password logins only.
      MfaSatisfied: { none: '401 unauthenticated', pending: '401 unauthenticated', session: '403 mfa_required', impersonation: '403 mfa_required', token: 'pass', agent: 'pass', key: 'pass' },
    };
    const POLICIES: Record<string, Class<BasePolicy>> = { Authenticated, NoSession, NotLoggedPolicy, NoTokenAuthPolicy, NoImpersonationPolicy, FreshAuth, MfaSatisfied };

    for (const [name, row] of Object.entries(MATRIX)) {
      it(`${name}: ${KINDS.map((k) => `${k} ${row[k]}`).join(', ')}`, async () => {
        s.step.enrol(alice);
        const got: Record<string, string> = {};
        for (const kind of KINDS) got[kind] = await run(resolve(POLICIES[name]), await requestOf(kind));
        expect(got).to.deep.eq(row);
      });
    }

    it('a refusal carries a stable error code and a message', async () => {
      try {
        await resolve(Authenticated).execute(await requestOf('none'), route, controller);
        expect.fail('passed');
      } catch (e) {
        expect(e).to.be.instanceOf(AuthenticationFailed);
        expect((e as { error: string }).error).to.eq('unauthenticated');
        expect((e as Error).message).to.be.a('string').and.not.eq('');
      }
    });
  });

  describe('MfaSatisfied (D2: no step required, or aal2)', () => {
    it('an aal2 session passes although a step is required', async () => {
      s.step.enrol(alice);
      expect(await run(resolve(MfaSatisfied), await requestOf('session', { facts: { assurance: 'aal2', mfa: ['totp'] } }))).to.eq('pass');
    });

    it('an aal1 session passes when MfaPolicy requires no step', async () => {
      expect(await run(resolve(MfaSatisfied), await requestOf('session'))).to.eq('pass');
    });

    it('asks the MfaPolicy named by authn.mfa.policy.service with the principal and its method and strategy', async () => {
      s.step.enrol(alice);
      const policy = (await s.child.resolve(MfaPolicy)) as unknown as EnrolledMfaPolicy;
      const calls: unknown[] = [];
      const original = policy.required.bind(policy);
      policy.required = async (id, facts) => {
        calls.push({ id, facts });
        return original(id, facts);
      };
      try {
        await run(resolve(MfaSatisfied), await requestOf('key'));
      } finally {
        policy.required = original;
      }
      expect(calls).to.have.length(1);
      expect(calls[0]).to.deep.include({ id: { type: 'user', id: alice.id } });
      expect((calls[0] as { facts: object }).facts).to.include({ method: 'jws', strategy: 'keys' });
    });

    it('an unknown authn.mfa.policy.service fails the request instead of passing it', async () => {
      const config = await DI.resolve(Configuration);
      config.set('authn.mfa.policy.service', 'NoSuchMfaPolicy');
      try {
        const res = await outcome(resolve(MfaSatisfied).execute(await requestOf('session'), route, controller)).catch((e: Error) => `throws ${e.constructor.name}`);
        expect(res).to.eq('throws InvalidOption');
      } finally {
        config.set('authn.mfa.policy.service', 'PolicySuiteMfaPolicy');
      }
    });

    it('a registration under the configured name that is no MfaPolicy (no required()) fails with InvalidOption', async () => {
      // A grandchild of its own, so the suite's later MfaPolicy resolves never meet this registration.
      const sub = s.child.child();
      bind(sub, MfaPolicy, 'PolicySuiteMfaPolicyWithoutRequired', {});
      const policy = new MfaSatisfied();
      Object.defineProperty(policy, 'Container', { value: sub });
      const config = await DI.resolve(Configuration);
      config.set('authn.mfa.policy.service', 'PolicySuiteMfaPolicyWithoutRequired');
      try {
        const res = await outcome(policy.execute(await requestOf('session'), route, controller)).catch((e: Error) => `throws ${e.constructor.name}`);
        expect(res).to.eq('throws InvalidOption');
      } finally {
        config.set('authn.mfa.policy.service', 'PolicySuiteMfaPolicy');
        await sub.dispose();
      }
    });
  });

  describe('FreshAuth (A13, SR-20)', () => {
    const reauthAttempts = () => s.throttle.attempts.filter((a) => a.flow === 'reauth');

    it('a session within authn.freshAuth.maxAgeSeconds passes without re-authentication', async () => {
      expect(await run(resolve(FreshAuth), await requestOf('session', { facts: { authenticatedAt: secondsAgo(290) } }))).to.eq('pass');
      expect(reauthAttempts()).to.have.length(0);
    });

    it('a stale session without a password is refused 403 fresh_auth_required', async () => {
      expect(await run(resolve(FreshAuth), await requestOf('session', { facts: { authenticatedAt: secondsAgo(310) } }))).to.eq('403 fresh_auth_required');
      expect(reauthAttempts()).to.have.length(0);
    });

    it('a stale session passes with the right reauthPassword, through the reauth throttle, and its facts stay', async () => {
      const req = await requestOf('session', { facts: { authenticatedAt: secondsAgo(400) }, body: { reauthPassword: ALICE_PASSWORD } });
      const before = (req.storage.AuthnSession as { facts: AuthnFacts }).facts.authenticatedAt.getTime();
      expect(await run(resolve(FreshAuth), req)).to.eq('pass');
      expect(reauthAttempts()).to.have.length(1);
      expect(reauthAttempts()[0].ctx).to.include({ purpose: 'reauth', ip: '203.0.113.7', userAgent: 'policy-suite' });
      expect(s.throttle.succeeds.map((x) => x.flow)).to.deep.eq(['reauth']);
      const id = (req.storage.AuthnSession as { handle: { id: string } }).handle.id;
      expect((await s.issuer.restore(id))!.facts.authenticatedAt.getTime(), 'a re-authentication changes no session facts').to.eq(before);
    });

    it('a wrong reauthPassword answers like a failed login (401 E_AUTH_FAILED) and counts in the reauth throttle', async () => {
      const req = await requestOf('session', { facts: { authenticatedAt: secondsAgo(400) }, body: { reauthPassword: 'wrong-password-1' } });
      expect(await run(resolve(FreshAuth), req)).to.eq('401 E_AUTH_FAILED');
      expect(reauthAttempts()).to.have.length(1);
      expect(s.throttle.succeeds).to.have.length(0);
    });

    it("another account's password never counts as fresh auth", async () => {
      const req = await requestOf('session', { facts: { authenticatedAt: secondsAgo(400) }, body: { reauthPassword: BOB_PASSWORD } });
      expect(await run(resolve(FreshAuth), req)).to.eq('401 E_AUTH_FAILED');
    });

    it('a throttled re-authentication answers the same 401 and carries no retry information', async () => {
      s.throttle.refuse(30);
      try {
        await resolve(FreshAuth).execute(await requestOf('session', { facts: { authenticatedAt: secondsAgo(400) }, body: { reauthPassword: ALICE_PASSWORD } }), route, controller);
        expect.fail('passed');
      } catch (e) {
        expect(e).to.be.instanceOf(AuthenticationFailed);
        expect((e as { error: unknown }).error).to.deep.eq({ code: 'E_AUTH_FAILED', message: 'login or password incorrect' });
        expect(JSON.stringify({ ...(e as object) })).to.not.match(/retry/i);
      }
      expect(s.passwordStrategy.verifyCalls, 'a throttled attempt verifies nothing').to.have.length(0);
    });

    it('an impersonation session is never fresh, even with a password, and verifies nothing', async () => {
      const req = await requestOf('impersonation', { body: { reauthPassword: ALICE_PASSWORD } });
      expect(await run(resolve(FreshAuth), req)).to.eq('403 impersonating');
      expect(reauthAttempts()).to.have.length(0);
    });

    for (const kind of ['token', 'agent', 'key'] as const) {
      it(`a per-request ${kind} principal is refused even with a password`, async () => {
        expect(await run(resolve(FreshAuth), await requestOf(kind, { body: { reauthPassword: ALICE_PASSWORD } }))).to.eq('403 session_required');
        expect(reauthAttempts()).to.have.length(0);
      });
    }

    it('@Policy(FreshAuth, 600): the constructor argument replaces the configured age', async () => {
      const p600 = resolve(FreshAuth, [600]);
      expect(p600.maxAgeSeconds).to.eq(600);
      expect(await run(p600, await requestOf('session', { facts: { authenticatedAt: secondsAgo(400) } }))).to.eq('pass');
      expect(await run(resolve(FreshAuth), await requestOf('session', { facts: { authenticatedAt: secondsAgo(400) } }))).to.eq('403 fresh_auth_required');
    });

    it('each resolve is a new instance, so two routes keep their own maxAgeSeconds', () => {
      const a = resolve(FreshAuth, [600]);
      const b = resolve(FreshAuth);
      expect(a).to.not.eq(b);
      expect([a.maxAgeSeconds, b.maxAgeSeconds]).to.deep.eq([600, undefined]);
    });

    describe('a maxAgeSeconds stricter than the configured one', () => {
      // 100 s old: fresh under the configured 300 s, stale under 60 s.
      const request = (body?: unknown) => requestOf('session', { facts: { authenticatedAt: secondsAgo(100) }, body });

      it('refuses without a password', async () => {
        expect(await run(resolve(FreshAuth, [60]), await request())).to.eq('403 fresh_auth_required');
      });

      it('verifies the password: a wrong one fails', async () => {
        expect(await run(resolve(FreshAuth, [60]), await request({ reauthPassword: 'wrong-password-1' }))).to.eq('401 E_AUTH_FAILED');
        expect(reauthAttempts()).to.have.length(1);
      });

      it('verifies the password: the right one passes', async () => {
        expect(await run(resolve(FreshAuth, [60]), await request({ reauthPassword: ALICE_PASSWORD }))).to.eq('pass');
        expect(reauthAttempts()).to.have.length(1);
      });

      it("another account's password fails, counted once in the reauth flow", async () => {
        expect(await run(resolve(FreshAuth, [60]), await request({ reauthPassword: BOB_PASSWORD }))).to.eq('401 E_AUTH_FAILED');
        expect(reauthAttempts()).to.have.length(1);
        expect(s.throttle.succeeds).to.have.length(0);
      });

      it('a throttled re-authentication fails and verifies nothing', async () => {
        s.throttle.refuse(30);
        expect(await run(resolve(FreshAuth, [60]), await request({ reauthPassword: ALICE_PASSWORD }))).to.eq('401 E_AUTH_FAILED');
        expect(s.passwordStrategy.verifyCalls).to.have.length(0);
      });

      it('the right password of a banned identity fails, refused for the ban', async () => {
        const req = await request({ reauthPassword: ALICE_PASSWORD });
        s.identities.setStatus(alice, { banned: true });
        expect(await run(resolve(FreshAuth, [60]), req)).to.eq('401 E_AUTH_FAILED');
        expect(s.throttle.succeeds).to.have.length(0);
        expect(reauthAttempts(), 'the attempt reached core').to.have.length(1);
        const refused = s.events.ofType('reauth').filter((e) => e.identity?.id === alice.id);
        expect(refused.map((e) => [e.outcome, e.reason])).to.deep.eq([['failure', 'banned']]);
      });
    });

    it('undefined maxAgeSeconds means authn.freshAuth.maxAgeSeconds (300 here)', async () => {
      expect(await run(resolve(FreshAuth), await requestOf('session', { facts: { authenticatedAt: secondsAgo(295) } }))).to.eq('pass');
      expect(await run(resolve(FreshAuth), await requestOf('session', { facts: { authenticatedAt: secondsAgo(305) } }))).to.eq('403 fresh_auth_required');
    });

    it('a maxAgeSeconds that is not a positive integer fails when the route is built', () => {
      for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) expect(() => new FreshAuth(bad), String(bad)).to.throw(/maxAgeSeconds/);
    });

    it('a password over the 1024 character cap fails without reaching a strategy', async () => {
      const req = await requestOf('session', { facts: { authenticatedAt: secondsAgo(400) }, body: { reauthPassword: 'x'.repeat(1025) } });
      expect(await run(resolve(FreshAuth), req)).to.eq('401 E_AUTH_FAILED');
      expect(s.passwordStrategy.verifyCalls).to.have.length(0);
      const failed = s.events.ofType('reauth').filter((e) => e.identity?.id === alice.id);
      expect(failed.map((e) => [e.outcome, e.reason])).to.deep.eq([['failure', 'password_too_long']]);
      expect(failed[0].session).to.eq((req.storage.AuthnSession as { facts: AuthnFacts }).facts.sessionHandle);
      expect(JSON.stringify(failed)).to.not.contain('xxxxxxxx');
    });

    it('a reauthPassword that is not a non-empty string counts as none', async () => {
      for (const reauthPassword of ['', 42, ['x'], { p: 'x' }, null]) {
        expect(await run(resolve(FreshAuth), await requestOf('session', { facts: { authenticatedAt: secondsAgo(400) }, body: { reauthPassword } })), JSON.stringify(reauthPassword)).to.eq('403 fresh_auth_required');
      }
      expect(reauthAttempts()).to.have.length(0);
    });

    it('an identity without an email (the login IdentityStore gives) cannot re-authenticate inline', async () => {
      const carol = s.identities.add({ login: `carol-${randomUUID()}` });
      await s.passwords.set(carol, fakeHash('Carol-Pass-3456'));
      const h = await s.issuer.issue(carol, FACTS({ authenticatedAt: secondsAgo(400) }));
      const restored = (await s.issuer.restore(h.id))!;
      const req = { storage: { AuthnSession: restored, AuthnPrincipal: { type: 'user', id: carol.id, authenticated: true, source: 'session', attributes: {}, authn: restored.facts } }, body: { reauthPassword: 'Carol-Pass-3456' }, headers: {} } as unknown as Request;
      expect(await run(resolve(FreshAuth), req)).to.eq('401 E_AUTH_FAILED');
      const failed = s.events.ofType('reauth').filter((e) => e.identity?.id === carol.id);
      expect(failed.map((e) => [e.outcome, e.reason]), 'audited, so the missing login leaves a trace').to.deep.eq([['failure', 'no_login']]);
      expect(JSON.stringify(failed)).to.not.contain('Carol-Pass-3456');
    });

    it('takes reauthPassword out of the body, so the route never sees the password', async () => {
      for (const age of [400, 290]) {
        const req = await requestOf('session', { facts: { authenticatedAt: secondsAgo(age) }, body: { reauthPassword: ALICE_PASSWORD, note: 'kept' } });
        expect(await run(resolve(FreshAuth), req)).to.eq('pass');
        expect(req.body, `${age} s`).to.deep.eq({ note: 'kept' });
      }
      const wrong = await requestOf('session', { facts: { authenticatedAt: secondsAgo(400) }, body: { reauthPassword: 'wrong-password-1' } });
      expect(await run(resolve(FreshAuth), wrong)).to.eq('401 E_AUTH_FAILED');
      expect(wrong.body).to.deep.eq({});
    });

    it('drops the raw body bytes too when they held reauthPassword; a body without the field keeps them', async () => {
      const raw = Buffer.from(JSON.stringify({ reauthPassword: ALICE_PASSWORD, note: 'kept' }));
      const req = await requestOf('session', { facts: { authenticatedAt: secondsAgo(400) }, body: { reauthPassword: ALICE_PASSWORD, note: 'kept' } });
      (req as unknown as { rawBody?: Buffer }).rawBody = raw;
      expect(await run(resolve(FreshAuth), req)).to.eq('pass');
      expect((req as unknown as { rawBody?: Buffer }).rawBody).to.eq(undefined);
      const other = await requestOf('session', { facts: { authenticatedAt: secondsAgo(290) }, body: { note: 'kept' } });
      const otherRaw = Buffer.from('{"note":"kept"}');
      (other as unknown as { rawBody?: Buffer }).rawBody = otherRaw;
      expect(await run(resolve(FreshAuth), other)).to.eq('pass');
      expect((other as unknown as { rawBody?: Buffer }).rawBody).to.eq(otherRaw);
    });
  });

  describe('route args', () => {
    const extract = async (arg: { extract: (...a: never[]) => Promise<{ Args: unknown }> }, req: Request, options: unknown = undefined) => {
      const param = { Name: 'x', Options: options } as unknown as IRouteParameter;
      return (await (arg.extract as (...a: unknown[]) => Promise<{ Args: unknown }>)({ Payload: {} }, [], param, req, {})).Args;
    };

    it('@Identity(): the principal type, id and facts; null without a principal (pending included)', async () => {
      const session = await requestOf('session');
      expect(await extract(new AuthnIdentityArg(), session)).to.deep.eq({ identity: { type: 'user', id: alice.id }, facts: (session.storage.AuthnPrincipal as Principal).authn });
      expect(await extract(new AuthnIdentityArg(), await requestOf('agent')), "an agent's own id, not onBehalfOf").to.deep.include({ identity: { type: 'agent', id: 'agent-1' } });
      expect(await extract(new AuthnIdentityArg(), await requestOf('pending'))).to.eq(null);
      expect(await extract(new AuthnIdentityArg(), await requestOf('none'))).to.eq(null);
      const unauthenticated = await requestOf('session');
      unauthenticated.storage.AuthnPrincipal = { ...(unauthenticated.storage.AuthnPrincipal as Principal), authenticated: false } as Principal;
      expect(await extract(new AuthnIdentityArg(), unauthenticated), 'as Authenticated: only authenticated === true counts').to.eq(null);
    });

    it('@AuthnSession(): the handle, pending included; null without a session', async () => {
      const pending = await requestOf('pending');
      expect(await extract(new AuthnSessionArg(), pending)).to.deep.eq((pending.storage.AuthnSession as { handle: unknown }).handle);
      expect(((await extract(new AuthnSessionArg(), pending)) as { state: string }).state).to.eq('pending');
      expect(await extract(new AuthnSessionArg(), await requestOf('token'))).to.eq(null);
    });

    it('@SessionId(): the raw id of the restored session, pending included; null without one', async () => {
      const pending = await requestOf('pending');
      expect(await extract(new AuthnSessionIdArg(), pending)).to.eq((pending.storage.AuthnSession as { handle: { id: string } }).handle.id);
      expect(await extract(new AuthnSessionIdArg(), await requestOf('none'))).to.eq(null);
    });

    it('@FromSession(key): the session data value, pending included; undefined without a session or key', async () => {
      const pending = await requestOf('pending');
      const handle = pending.storage.AuthnSession!.handle;
      await s.issuer.set(handle, 'cart', { items: 2 });
      pending.storage.AuthnSession = await s.issuer.restore(handle.id);
      expect(await extract(new AuthnSessionDataArg(), pending, { key: 'cart' })).to.deep.eq({ items: 2 });
      expect(await extract(new AuthnSessionDataArg(), pending, { key: 'other' })).to.eq(undefined);
      expect(await extract(new AuthnSessionDataArg(), await requestOf('none'), { key: 'cart' })).to.eq(undefined);
    });

    it('FromSession needs a non-empty key', () => {
      expect(() => v3.FromSession('')).to.throw(/key/);
      expect(() => v3.FromSession(42 as unknown as string)).to.throw(/key/);
    });

    it('registerAuthnHttpV3 registers the route args in the root container, where @spinajs/http resolves them by name', () => {
      for (const c of [AuthnIdentityArg, AuthnSessionArg, AuthnSessionIdArg, AuthnSessionDataArg]) {
        expect(DI.RootContainer.hasRegistered(c.name), c.name).to.eq(true);
        expect(s.child.hasRegistered(c.name, false), c.name).to.eq(false);
      }
    });
  });

  describe('over HTTP (AuthnMiddleware, real cookies)', () => {
    const get = async (path: string, headers: Record<string, string> = {}) => {
      let call = http().get(`${POLICY_PROBE_PATH}/${path}`).set('Accept', 'application/json');
      for (const [k, v] of Object.entries(headers)) call = call.set(k, v);
      return call;
    };
    const post = async (path: string, headers: Record<string, string>, body: object = {}) => {
      let call = http().post(`${POLICY_PROBE_PATH}/${path}`).set('Accept', 'application/json').set('Origin', APP_ORIGIN);
      for (const [k, v] of Object.entries(headers)) call = call.set(k, v);
      return call.send(body);
    };
    const session = async (facts: Partial<AuthnFacts> = {}, pending = false) => s.issuer.issue(alice, FACTS(facts), pending ? { pending: { steps: ['totp'] } } : undefined);

    it('Authenticated: 200 with a session, 401 { error: unauthenticated } without one or with a pending one', async () => {
      expect((await get('authenticated', { Cookie: cookieOf((await session()).id) })).status).to.eq(200);
      const none = await get('authenticated');
      expect(none.status).to.eq(401);
      expect(none.body.error).to.eq('unauthenticated');
      expect((await get('authenticated', { Cookie: cookieOf((await session({}, true)).id) })).status).to.eq(401);
    });

    it('FreshAuth: a stale session with the right reauthPassword passes; a wrong or throttled one is 401 A02 with no Retry-After', async () => {
      const h = await session({ authenticatedAt: secondsAgo(400) });
      expect((await post('fresh', { Cookie: cookieOf(h.id) })).status).to.eq(403);
      expect((await post('fresh', { Cookie: cookieOf(h.id) }, { reauthPassword: ALICE_PASSWORD })).status).to.eq(200);
      const wrong = await post('fresh', { Cookie: cookieOf(h.id) }, { reauthPassword: 'wrong-password-1' });
      expect(wrong.status).to.eq(401);
      expect(wrong.body.error).to.deep.eq({ code: 'E_AUTH_FAILED', message: 'login or password incorrect' });
      expect(wrong.headers['retry-after']).to.eq(undefined);
      s.throttle.refuse(30);
      const throttled = await post('fresh', { Cookie: cookieOf(h.id) }, { reauthPassword: ALICE_PASSWORD });
      expect(throttled.status).to.eq(401);
      expect(throttled.body.error).to.deep.eq(wrong.body.error);
      expect(throttled.headers['retry-after']).to.eq(undefined);
    });

    it('FreshAuth: the controller gets the body without reauthPassword', async () => {
      const h = await session({ authenticatedAt: secondsAgo(400) });
      const res = await post('fresh', { Cookie: cookieOf(h.id) }, { reauthPassword: ALICE_PASSWORD, note: 'kept' });
      expect(res.status).to.eq(200);
      expect(res.body.bodyKeys).to.deep.eq(['note']);
      expect(res.body.rawBody, 'nor the raw bytes').to.eq(null);
    });

    it('@Policy(FreshAuth, 600) reaches the policy: 400 s old passes there and not on the default route', async () => {
      const h = await session({ authenticatedAt: secondsAgo(400) });
      expect((await post('fresh-600', { Cookie: cookieOf(h.id) })).status).to.eq(200);
      const dflt = await post('fresh', { Cookie: cookieOf(h.id) });
      expect(dflt.status).to.eq(403);
      expect(dflt.body.error).to.eq('fresh_auth_required');
    });

    it('MfaSatisfied: aal1 with an enrolled step is 403 mfa_required, aal2 passes', async () => {
      s.step.enrol(alice);
      const aal1 = await get('mfa', { Cookie: cookieOf((await session()).id) });
      expect(aal1.status).to.eq(403);
      expect(aal1.body.error).to.eq('mfa_required');
      expect((await get('mfa', { Cookie: cookieOf((await session({ assurance: 'aal2', mfa: ['totp'] })).id) })).status).to.eq(200);
    });

    it('NoTokenAuthPolicy refuses a token principal; NoImpersonationPolicy an impersonation; NoSession and NotLoggedPolicy a session', async () => {
      const token = `spt_${randomBytes(12).toString('base64url')}`;
      s.tokens.set(token, { ok: true, identity: alice, method: 'token' });
      const byToken = await get('no-token', { Authorization: `Bearer ${token}` });
      expect(byToken.status).to.eq(403);
      expect(byToken.body.error).to.eq('session_required');
      expect((await get('no-token', { Cookie: cookieOf((await session()).id) })).status).to.eq(200);

      const imp = await s.issuer.issue(alice, FACTS({ impersonator: bob }));
      await s.issuer.set(imp, IMPERSONATION_BLOCK, { startedAt: new Date().toISOString() });
      const impersonating = await get('no-impersonation', { Cookie: cookieOf(imp.id) });
      expect(impersonating.status).to.eq(403);
      expect(impersonating.body.error).to.eq('impersonating');

      const own = cookieOf((await session()).id);
      expect((await get('no-session', { Cookie: own })).status).to.eq(403);
      expect((await get('no-session')).status).to.eq(200);
      expect((await get('not-logged', { Cookie: own })).status).to.eq(403);
      expect((await get('not-logged', { Cookie: cookieOf((await session({}, true)).id) })).status, 'a pending session may start over').to.eq(200);
    });

    it('route args: a session, a pending session and no session', async () => {
      const h = await session();
      await s.issuer.set(h, 'cart', ['book']);
      const active = await get('args', { Cookie: cookieOf(h.id) });
      expect(active.status).to.eq(200);
      expect(active.body.identity.identity).to.deep.eq({ type: 'user', id: alice.id });
      expect(active.body.identity.facts).to.include({ method: 'password', strategy: 'local' });
      expect(active.body.session).to.deep.eq({ id: h.id, state: 'active' });
      expect(active.body.sessionId).to.eq(h.id);
      expect(active.body.cart).to.deep.eq(['book']);

      const p = await session({}, true);
      await s.issuer.set(p, 'cart', ['pen']);
      const pending = await get('args', { Cookie: cookieOf(p.id) });
      expect(pending.body.identity).to.eq(null);
      expect(pending.body.session).to.deep.eq({ id: p.id, state: 'pending' });
      expect(pending.body.sessionId).to.eq(p.id);
      expect(pending.body.cart).to.deep.eq(['pen']);

      const none = await get('args');
      expect(none.body).to.deep.eq({ identity: null, session: null, sessionId: null, cart: '<undefined>' });
    });
  });
});
