import assert from 'node:assert/strict';
import 'mocha';
import * as sinon from 'sinon';
import { FakeStrategy, KIT_ATTRIBUTES, RecordingPrincipalFactory, fakeHash } from '@spinajs/authn-testing';
import type { Configuration } from '@spinajs/configuration';
import type { IContainer } from '@spinajs/di';
import { ActionHook, DefaultHooks } from '@spinajs/hooks';
import type { ActionName, ActionPattern, BeforeContext } from '@spinajs/hooks';
import { RecordingActionHook, mutatingHook, refusingHook } from '@spinajs/hooks/testing';

import { MemoryAuthnThrottle, PrincipalFactory } from '../../src/index.js';
import type { AuthenticationResult, AuthnContext, Credentials, ExternalSubject, IdentityRef, SessionHandle, ThrottleFlow, ThrottleKey } from '../../src/index.js';
import { bind, buildCore, pinConfiguration, useHarnessLog } from '../behaviour/harness.js';
import type { CoreOptions, CoreParts, StrategySpec } from '../behaviour/harness.js';

const IP = '192.0.2.10';
const OTHER_IP = '203.0.113.9';
const ALICE = { login: 'alice@example.test', password: 'Alice-Pass-1234' };
const BOB = { login: 'bob@example.test', password: 'Bob-Pass-2345x' };

class RecordingThrottle extends MemoryAuthnThrottle {
  readonly attempts: { keys: string[]; flow: ThrottleFlow }[] = [];
  readonly succeeds: { keys: string[]; flow: ThrottleFlow }[] = [];

  async attempt(keys: readonly ThrottleKey[], flow: ThrottleFlow, ctx: AuthnContext) {
    this.attempts.push({ keys: keys.map((k) => `${k.kind}=${k.value}`), flow });
    return super.attempt(keys, flow, ctx);
  }

  async succeed(keys: readonly ThrottleKey[], flow: ThrottleFlow) {
    this.succeeds.push({ keys: keys.map((k) => `${k.kind}=${k.value}`), flow });
    return super.succeed(keys, flow);
  }
}

/** A before hook that throws something other than a refusal. */
class ThrowingHook extends ActionHook {
  constructor(readonly actions: readonly ActionPattern[]) {
    super();
  }

  before(): void {
    throw new RangeError('group sync down');
  }
}

/** A before hook that runs `change` on the input. */
class ChangingHook extends ActionHook {
  constructor(
    readonly actions: readonly ActionPattern[],
    private readonly change: (ctx: BeforeContext<ActionName>) => void,
  ) {
    super();
  }

  before(ctx: BeforeContext<ActionName>): void {
    this.change(ctx);
  }
}

type Success = Extract<AuthenticationResult, { status: 'success' }>;

const ctx = (over: Partial<AuthnContext> = {}): AuthnContext => ({ now: new Date(), ip: IP, purpose: 'login', ...over });
const pw = (login: string, password: string): Credentials => ({ kind: 'password', login, password });

function success(r: AuthenticationResult): Success {
  assert.strictEqual(r.status, 'success', JSON.stringify(r));
  return r;
}

describe('action hooks: authn.login and authn.login.identified', function () {
  this.timeout(30000);

  useHarnessLog();

  let parts: CoreParts | undefined;
  let throttle: RecordingThrottle | undefined;

  afterEach(async () => {
    sinon.restore();
    await parts?.dispose();
    parts = undefined;
    throttle = undefined;
  });

  async function boot(hooks: readonly ActionHook[], opts: CoreOptions = {}): Promise<CoreParts> {
    parts = await buildCore({}, { throttle: (_c: Configuration, k: IContainer) => (throttle = pinConfiguration(new RecordingThrottle(), k)), hooks, ...opts });
    return parts;
  }

  const seed = async (p: CoreParts, u: { login: string; password: string } = ALICE): Promise<IdentityRef> => {
    const id = p.identities.add({ login: u.login, email: u.login });
    await p.passwords.set(id, fakeHash(u.password));
    return id;
  };

  const verifyCalls = (p: CoreParts): number => p.strategies.reduce((n, s) => n + ((s.instance as FakeStrategy | undefined)?.verifyCalls.length ?? 0), 0);

  const loginFailures = (p: CoreParts) => p.events.ofType('login').filter((e) => e.outcome === 'failure');

  describe('authn.login', () => {
    it('a refusal answers invalid_credentials, audits the login with hook:<code>, and neither counts nor verifies', async () => {
      const p = await boot([refusingHook('authn.login', 'kit-closed')]);
      await seed(p);
      const r = await p.service.authenticate(pw(ALICE.login, ALICE.password), ctx());
      assert.deepStrictEqual(r, { status: 'failure', reason: 'invalid_credentials' });
      assert.deepStrictEqual(
        loginFailures(p).map((e) => e.reason),
        ['hook:kit-closed'],
      );
      assert.deepStrictEqual(throttle!.attempts, [], 'AuthnThrottle.attempt is never called');
      assert.strictEqual(verifyCalls(p), 0, 'no strategy verifies');
      assert.deepStrictEqual(await p.sessions.storage.storedKeys(), []);
    });

    it('a hook that throws answers invalid_credentials and audits hook_error', async () => {
      const p = await boot([new ThrowingHook(['authn.login'])]);
      await seed(p);
      assert.deepStrictEqual(await p.service.authenticate(pw(ALICE.login, ALICE.password), ctx()), { status: 'failure', reason: 'invalid_credentials' });
      assert.deepStrictEqual(
        loginFailures(p).map((e) => e.reason),
        ['hook_error'],
      );
      assert.strictEqual(verifyCalls(p), 0);
    });

    it('a hook that lower-cases credentials.login makes the strategy see the new value', async () => {
      const lower = new ChangingHook(['authn.login'], (c) => {
        const input = c.input as { credentials: Credentials };
        input.credentials = { ...input.credentials, login: String((input.credentials as { login: string }).login).toLowerCase() };
      });
      const p = await boot([lower]);
      const a = await seed(p);
      const r = success(await p.service.authenticate(pw(ALICE.login.toUpperCase(), ALICE.password), ctx()));
      assert.deepStrictEqual(r.identity, a);
      const local = p.strategies.find((s) => s.name === 'local')!.instance as FakeStrategy;
      assert.deepStrictEqual(
        local.verifyCalls.map((c) => (c as { login: string }).login),
        [ALICE.login],
      );
    });

    it('a hook that assigns ctx changes nothing', async () => {
      const p = await boot([mutatingHook('authn.login', { ctx: { now: new Date(0), ip: OTHER_IP, purpose: 'request' } })]);
      await seed(p);
      success(await p.service.authenticate(pw(ALICE.login, ALICE.password), ctx()));
      assert.ok(
        throttle!.attempts.every((x) => x.flow === 'login' && x.keys.includes(`ip=${IP}`) && !x.keys.some((k) => k.includes(OTHER_IP))),
        JSON.stringify(throttle!.attempts),
      );
      assert.ok(p.events.all().length > 0);
      for (const e of p.events.all()) assert.strictEqual(e.ip, IP, JSON.stringify(e));
      assert.ok(await p.sessions.storage.storedKeys().then((k) => k.length === 1), 'still an interactive login with a session');
    });

    it('the input carries the credentials and the context, never an identity', async () => {
      const recorder = new RecordingActionHook(['authn.login']);
      const p = await boot([recorder]);
      await seed(p);
      success(await p.service.authenticate(pw(ALICE.login, ALICE.password), ctx()));
      assert.deepStrictEqual(
        recorder.calls.map((c) => c.phase),
        ['before', 'after'],
      );
      const input = recorder.calls[0].input as Record<string, unknown>;
      assert.deepStrictEqual(Object.keys(input).sort(), ['credentials', 'ctx']);
      assert.ok(!('identity' in input));
      assert.strictEqual((recorder.calls[1].output as AuthenticationResult).status, 'success');
    });
  });

  describe('authn.login.identified', () => {
    const SUBJECT: ExternalSubject = { provider: 'kit-idp', subject: 'sub-1', email: ALICE.login, emailVerified: true };
    const external = { kind: 'external', provider: 'kit-idp', payload: { subject: 'sub-1' } } as Credentials;

    it('runs once for a password login, with the identity, strategy local, method password and no external', async () => {
      const recorder = new RecordingActionHook(['authn.login.identified']);
      const p = await boot([recorder]);
      const a = await seed(p);
      success(await p.service.authenticate(pw(ALICE.login, ALICE.password), ctx()));
      assert.deepStrictEqual(
        recorder.calls.map((c) => c.phase),
        ['before', 'after'],
      );
      const input = recorder.calls[0].input as Record<string, unknown>;
      assert.deepStrictEqual(input.identity, a);
      assert.strictEqual(input.strategy, 'local');
      assert.strictEqual(input.method, 'password');
      assert.ok(!('external' in input) || input.external === undefined, 'no external for a password login');
      assert.deepStrictEqual(input.attributes, {});
    });

    it('runs for an OIDC subject with external set', async () => {
      const recorder = new RecordingActionHook(['authn.login.identified']);
      const p = await boot([recorder]);
      const a = await seed(p);
      await p.links.link(a, SUBJECT);
      p.externalSubjects.set('sub-1', SUBJECT);
      success(await p.service.authenticate(external, ctx()));
      const befores = recorder.calls.filter((c) => c.phase === 'before');
      assert.strictEqual(befores.length, 1);
      const input = befores[0].input as Record<string, unknown>;
      assert.deepStrictEqual(input.identity, a);
      assert.strictEqual(input.strategy, 'fake-idp');
      assert.strictEqual(input.method, 'oidc');
      assert.deepStrictEqual(input.external, SUBJECT);
    });

    it('never runs for a token or key strategy', async () => {
      const OWNER: IdentityRef = { type: 'user', id: 'owner-1' };
      const tok = new FakeStrategy({ name: 'tok', kinds: ['bearer'], interactive: false, keys: () => [], verify: () => ({ ok: true, identity: OWNER, method: 'token' }) });
      const keys = new FakeStrategy({ name: 'keys', kinds: ['jws-assertion'], interactive: false, keys: () => [], verify: () => ({ ok: true, identity: OWNER, method: 'jws' }) });
      const strategies: StrategySpec[] = [tok, keys].map((s) => ({ name: s.name, service: `Svc_${s.name}`, instance: s, listed: true }));
      const recorder = new RecordingActionHook(['authn.login.identified']);
      const p = await boot([recorder], { strategies });
      p.identities.add({ id: OWNER.id, login: 'owner@example.test' });
      for (const purpose of ['request', 'login'] as const) {
        success(await p.service.authenticate({ kind: 'bearer', token: 't' }, ctx({ purpose })));
        success(await p.service.authenticate({ kind: 'jws-assertion', jws: 'x' }, ctx({ purpose })));
      }
      assert.deepStrictEqual(recorder.calls, []);
    });

    it('a refusal answers invalid_credentials after the throttle counted, issues no session, and audits hook:<code>', async () => {
      const p = await boot([refusingHook('authn.login.identified', 'kit-banned-group')]);
      const a = await seed(p);
      assert.deepStrictEqual(await p.service.authenticate(pw(ALICE.login, ALICE.password), ctx()), { status: 'failure', reason: 'invalid_credentials' });
      assert.deepStrictEqual(
        throttle!.attempts.map((x) => x.flow),
        ['login'],
        'the attempt is counted',
      );
      assert.deepStrictEqual(throttle!.succeeds, [], 'and not given back');
      assert.deepStrictEqual(await p.sessions.storage.storedKeys(), [], 'no session');
      const refused = loginFailures(p);
      assert.strictEqual(refused.length, 1);
      assert.deepStrictEqual({ reason: refused[0].reason, strategy: refused[0].strategy, identity: refused[0].identity }, { reason: 'hook:kit-banned-group', strategy: 'local', identity: a });
      assert.ok(!p.events.all().some((e) => e.outcome === 'success'));
    });

    it('a refusal of an MFA login issues no pending session either', async () => {
      const p = await boot([refusingHook('authn.login.identified', 'kit-no')]);
      const a = await seed(p);
      p.step.enrol(a);
      assert.deepStrictEqual(await p.service.authenticate(pw(ALICE.login, ALICE.password), ctx()), { status: 'failure', reason: 'invalid_credentials' });
      assert.deepStrictEqual(await p.sessions.storage.storedKeys(), []);
      assert.ok(!p.events.all().some((e) => e.type === 'mfa.challenge'));
    });

    it('a thrown error answers the same and audits hook_error', async () => {
      const p = await boot([new ThrowingHook(['authn.login.identified'])]);
      const a = await seed(p);
      assert.deepStrictEqual(await p.service.authenticate(pw(ALICE.login, ALICE.password), ctx()), { status: 'failure', reason: 'invalid_credentials' });
      assert.deepStrictEqual(await p.sessions.storage.storedKeys(), []);
      assert.deepStrictEqual(
        loginFailures(p).map((e) => [e.reason, e.identity]),
        [['hook_error', a]],
      );
      assert.ok(!JSON.stringify(p.events.all()).includes('group sync down'), 'the error message stays out of the audit');
    });

    it('a refused external login creates no link by verified email', async () => {
      const p = await boot([refusingHook('authn.login.identified', 'kit-no')], { raw: { authn: { linking: { byVerifiedEmail: true } } } });
      await seed(p);
      p.externalSubjects.set('sub-1', SUBJECT);
      assert.deepStrictEqual(await p.service.authenticate(external, ctx()), { status: 'failure', reason: 'invalid_credentials' });
      assert.strictEqual(p.links.links.length, 0);
      assert.ok(!p.events.all().some((e) => e.type === 'identity.link'));
    });

    it('a changed attributes key reaches principalOf extra.attributes, and a PrincipalAttributeProvider key still wins', async () => {
      const principals = new RecordingPrincipalFactory({ derive: () => ({ tier: 'provider' }) });
      const enrich = new ChangingHook(['authn.login.identified'], (c) => {
        const input = c.input as { attributes: Readonly<Record<string, unknown>> };
        input.attributes = { ...input.attributes, team: 'hook', tier: 'hook' };
      });
      const p = await boot([enrich], { omit: ['PrincipalFactory'], register: (c) => bind(c, PrincipalFactory, 'KitDerivingPrincipals', principals) });
      const a = await seed(p);
      const r = success(await p.service.authenticate({ kind: 'kit-attributed-login', id: a }, ctx()));
      assert.deepStrictEqual(r.attributes, { ...KIT_ATTRIBUTES, team: 'hook', tier: 'hook' });
      const principal = await p.service.principalOf(r);
      assert.deepStrictEqual(principals.calls[principals.calls.length - 1].extra.attributes, { ...KIT_ATTRIBUTES, team: 'hook', tier: 'hook' });
      assert.deepStrictEqual(principal.attributes, { ...KIT_ATTRIBUTES, team: 'hook', tier: 'provider' });
    });

    it('a password login without strategy attributes keeps answering none unless a hook adds some', async () => {
      const p = await boot([new RecordingActionHook(['authn.login.identified'])]);
      await seed(p);
      const r = success(await p.service.authenticate(pw(ALICE.login, ALICE.password), ctx()));
      assert.strictEqual(r.attributes, undefined);
    });

    it('a changed identity is dropped', async () => {
      const bob: IdentityRef = { type: 'user', id: 'bob-1' };
      const p = await boot([mutatingHook('authn.login.identified', { identity: bob, strategy: 'other', method: 'other' })]);
      p.identities.add({ id: bob.id, login: BOB.login });
      const a = await seed(p);
      const r = success(await p.service.authenticate(pw(ALICE.login, ALICE.password), ctx()));
      assert.deepStrictEqual(r.identity, a);
      assert.strictEqual(r.facts.strategy, 'local');
      assert.strictEqual(r.facts.method, 'password');
      assert.deepStrictEqual((await p.sessions.restore(r.session!.id))?.identity, a);
    });
  });

  describe('zero cost', () => {
    it('with no hook registered, the login asks Hooks.has and never runs the runner or builds a context', async () => {
      const has = sinon.spy(DefaultHooks.prototype, 'has');
      const run = sinon.spy(DefaultHooks.prototype, 'run');
      const createContext = sinon.spy(DefaultHooks.prototype as unknown as { createContext: () => unknown }, 'createContext');
      const p = await boot([]);
      await seed(p);
      success(await p.service.authenticate(pw(ALICE.login, ALICE.password), ctx()));
      assert.deepStrictEqual(
        has.getCalls().map((c) => c.args[0]),
        ['authn.login', 'authn.login.identified'],
      );
      assert.strictEqual(run.callCount, 0);
      assert.strictEqual(createContext.callCount, 0);
    });

    for (const [action, title] of [
      ['authn.mfa.verify', 'completeMfa'],
      ['authn.session.stepUp', 'stepUp'],
    ] as const) {
      it(`with no hook registered, ${title} runs no action either`, async () => {
        const p = await boot([]);
        const a = await seed(p);
        const run = sinon.spy(DefaultHooks.prototype, 'run');
        if (action === 'authn.mfa.verify') {
          p.step.enrol(a);
          const r = await p.service.authenticate(pw(ALICE.login, ALICE.password), ctx());
          assert.strictEqual(r.status, 'mfa_required');
          success(await p.service.completeMfa((r as { pending: SessionHandle }).pending, p.step.name, p.step.nextCode(a), ctx()));
        } else {
          const r = success(await p.service.authenticate(pw(ALICE.login, ALICE.password), ctx()));
          p.step.enrol(a);
          success(await p.service.stepUp(r.session!, p.step.name, p.step.nextCode(a), ctx()));
        }
        assert.strictEqual(run.callCount, 0);
      });
    }

    it('a per-request credential runs no action at all', async () => {
      const run = sinon.spy(DefaultHooks.prototype, 'run');
      const p = await boot([new RecordingActionHook(['*'])]);
      const a = await seed(p);
      p.tokens.set('kit-token', a);
      success(await p.service.authenticate({ kind: 'bearer', token: 'kit-token' }, ctx({ purpose: 'request' })));
      assert.strictEqual(run.callCount, 0);
    });
  });
});
