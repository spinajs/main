import assert from 'node:assert/strict';
import 'mocha';
import { FakeClock, FakeStrategy, fakeHash } from '@spinajs/authn-testing';
import type { Configuration } from '@spinajs/configuration';

import { AuthnThrottle, DEFAULT_THROTTLE_PARAMS, DefaultAuthnService, ExternalLoginHook, MemoryAuthnThrottle, MfaPolicy, MfaStep } from '../../src/index.js';
import type { AuthenticationResult, AuthnContext, AuthnEvent, AuthnFacts, Credentials, ExternalSubject, IdentityRef, SessionHandle, StrategyOutcome, ThrottleFlow, ThrottleKey } from '../../src/index.js';
import { KIT_MFA_STEP, bind, buildCore, useHarnessLog } from '../behaviour/harness.js';
import { TestLog } from '../audit/test-log.js';
import type { CoreOptions, CoreParts, StrategySpec } from '../behaviour/harness.js';

const IP = '192.0.2.10';
const ALICE = { login: 'alice@example.test', password: 'Alice-Pass-1234' };
const WRONG = 'Wrong-Pass-9876';

class RecordingThrottle extends MemoryAuthnThrottle {
  readonly attempts: { keys: ThrottleKey[]; flow: ThrottleFlow }[] = [];
  readonly succeeds: { keys: ThrottleKey[]; flow: ThrottleFlow }[] = [];
  readonly peeks: { keys: ThrottleKey[]; flow: ThrottleFlow }[] = [];

  async peek(keys: readonly ThrottleKey[], flow: ThrottleFlow, ctx: AuthnContext) {
    this.peeks.push({ keys: [...keys], flow });
    return super.peek(keys, flow, ctx);
  }

  async attempt(keys: readonly ThrottleKey[], flow: ThrottleFlow, ctx: AuthnContext) {
    this.attempts.push({ keys: [...keys], flow });
    return super.attempt(keys, flow, ctx);
  }

  async succeed(keys: readonly ThrottleKey[], flow: ThrottleFlow) {
    this.succeeds.push({ keys: [...keys], flow });
    return super.succeed(keys, flow);
  }

  ipAttempts(ip: string): number {
    return this.tables.login.rows.get(this.keyId('login', { kind: 'ip', value: ip }))?.attempts ?? 0;
  }
}

const ctx = (over: Partial<AuthnContext> = {}): AuthnContext => ({ now: new Date(), ip: IP, purpose: 'login', ...over });
const pw = (login: string, password: string): Credentials => ({ kind: 'password', login, password });
const bearer = (token: string): Credentials => ({ kind: 'bearer', token });
const keyId = (k: ThrottleKey): string => `${k.kind}=${k.value}`;

type Failure = Extract<AuthenticationResult, { status: 'failure' }>;
type Success = Extract<AuthenticationResult, { status: 'success' }>;
type Pending = Extract<AuthenticationResult, { status: 'mfa_required' }>;

/** An MFA step with fixed answers; `accepts` is the one code verify takes. */
class StubStep extends MfaStep {
  readonly verifyCalls: string[] = [];
  declare verifyRecovery?: (id: IdentityRef, code: string) => Promise<boolean>;

  constructor(readonly name: string, private readonly opts: { enrolled: boolean; accepts?: string; recovery?: string }) {
    super();
    if (opts.recovery !== undefined) this.verifyRecovery = async (_id, code) => code === opts.recovery;
  }

  async enrolled(): Promise<boolean> {
    return this.opts.enrolled;
  }

  async beginEnrolment(): Promise<{ provisioning: string }> {
    return { provisioning: 'stub://' };
  }

  async confirmEnrolment(): Promise<{ recoveryCodes?: readonly string[] }> {
    return {};
  }

  async verify(_id: IdentityRef, response: string): Promise<boolean> {
    this.verifyCalls.push(response);
    return response === this.opts.accepts;
  }

  async disable(): Promise<void> {}
}

/** The kit step first, then `extra` registered under their names. */
const withSteps = (extra: readonly StubStep[], order: 'kit-first' | 'kit-last' = 'kit-first'): CoreOptions => {
  const kit = { name: 'fake', service: KIT_MFA_STEP };
  const listed = extra.map((s) => ({ name: s.name, service: `Step_${s.name}` }));
  return {
    register: (c) => extra.forEach((s) => bind(c, MfaStep, `Step_${s.name}`, s)),
    raw: { authn: { mfa: { steps: order === 'kit-first' ? [kit, ...listed] : [...listed, kit] } } },
  };
};

function failure(r: AuthenticationResult, reason: string): Failure {
  assert.strictEqual(r.status, 'failure', JSON.stringify(r));
  assert.strictEqual((r as Failure).reason, reason, JSON.stringify(r));
  return r as Failure;
}

function success(r: AuthenticationResult): Success {
  assert.strictEqual(r.status, 'success', JSON.stringify(r));
  return r as Success;
}

const loginFailures = (p: CoreParts): AuthnEvent[] => p.events.all().filter((e) => e.outcome === 'failure');

const strategy = (name: string, opts: { kinds?: string[]; interactive?: boolean; keys?: (c: Credentials, x: AuthnContext) => ThrottleKey[]; verify: (c: Credentials) => StrategyOutcome | Promise<StrategyOutcome> }): FakeStrategy => new FakeStrategy({ name, kinds: opts.kinds ?? ['bearer'], interactive: opts.interactive ?? false, keys: opts.keys ?? (() => []), verify: opts.verify });

const spec = (s: FakeStrategy, listed = true): StrategySpec => ({ name: s.name, service: `Svc_${s.name.replace(/[^A-Za-z0-9]/g, '_')}`, instance: s, listed });

const tokenOf = (c: Credentials): string => String((c as { token?: unknown }).token ?? '');

describe('DefaultAuthnService', function () {
  this.timeout(30000);

  useHarnessLog();

  let parts: CoreParts | undefined;
  let throttle: RecordingThrottle | undefined;

  afterEach(async () => {
    await parts?.dispose();
    parts = undefined;
    throttle = undefined;
  });

  async function boot(strategies: FakeStrategy[] | undefined, opts: CoreOptions = {}, config = {}): Promise<CoreParts> {
    parts = await buildCore(config, {
      throttle: (c: Configuration) => (throttle = new RecordingThrottle(c)),
      ...(strategies ? { strategies: strategies.map((s) => spec(s)) } : {}),
      ...opts,
    });
    return parts;
  }

  async function bootFails(strategies: FakeStrategy[] | undefined, opts: CoreOptions, ...parts: string[]): Promise<string> {
    let error: unknown;
    try {
      await boot(strategies, opts);
    } catch (e) {
      error = e;
    }
    assert.ok(error instanceof Error, 'the boot fails');
    for (const p of parts) assert.ok(error.message.includes(p), `${error.message} names ${p}`);
    return error.message;
  }

  const seedAlice = async (p: CoreParts, status = {}): Promise<IdentityRef> => {
    const id = p.identities.add({ login: ALICE.login, email: ALICE.login, status });
    await p.passwords.set(id, fakeHash(ALICE.password));
    return id;
  };

  describe('dispatch (D1)', () => {
    const OWNER: IdentityRef = { type: 'user', id: 'owner-1' };
    const isToken = (c: Credentials) => tokenOf(c).startsWith('spt_');
    const isJwt = (c: Credentials) => tokenOf(c).split('.').length === 3;
    const tokenLike = () =>
      strategy('token', {
        keys: (c, x) =>
          isToken(c)
            ? [
                { kind: 'account', value: 'tok:1' },
                { kind: 'account-ip', value: `tok:1|${x.ip ?? ''}` },
              ]
            : [],
        verify: (c) => (!isToken(c) ? { ok: false, reason: 'unsupported_credentials' } : tokenOf(c) === 'spt_good' ? { ok: true, identity: OWNER, method: 'token' } : { ok: false, reason: 'invalid_credentials' }),
      });
    const jwtLike = () =>
      strategy('jwt', {
        keys: (c, x) =>
          isJwt(c)
            ? [
                { kind: 'account', value: 'jwt:1' },
                { kind: 'account-ip', value: `jwt:1|${x.ip ?? ''}` },
              ]
            : [],
        verify: (c) => (!isJwt(c) ? { ok: false, reason: 'unsupported_credentials' } : tokenOf(c) === 'h.good.s' ? { ok: true, identity: OWNER, method: 'jwt' } : { ok: false, reason: 'invalid_credentials' }),
      });

    async function bootBearers(): Promise<{ p: CoreParts; token: FakeStrategy; jwt: FakeStrategy }> {
      const token = tokenLike();
      const jwt = jwtLike();
      const p = await boot([token, jwt]);
      p.identities.add({ id: OWNER.id, login: 'owner@example.test' });
      return { p, token, jwt };
    }

    it('sends each bearer value to the strategy whose format it has', async () => {
      const { p, token, jwt } = await bootBearers();
      assert.strictEqual(success(await p.service.authenticate(bearer('spt_good'), ctx({ purpose: 'request' }))).facts.strategy, 'token');
      assert.strictEqual(jwt.verifyCalls.length, 0, 'the jwt strategy never sees an spt_ value');
      assert.strictEqual(success(await p.service.authenticate(bearer('h.good.s'), ctx({ purpose: 'request' }))).facts.strategy, 'jwt');
      assert.strictEqual(token.verifyCalls.length, 2, 'the token strategy answered unsupported_credentials for the jwt');
      assert.strictEqual(jwt.verifyCalls.length, 1);
    });

    it('counts a failure once, with the union of the candidates keys and the ip', async () => {
      const { p } = await bootBearers();
      failure(await p.service.authenticate(bearer('h.bad.s'), ctx({ purpose: 'request' })), 'invalid_credentials');
      assert.deepStrictEqual(throttle!.peeks.map((x) => x.keys), throttle!.attempts.map((x) => x.keys));
      assert.strictEqual(throttle!.attempts.length, 1);
      assert.deepStrictEqual(throttle!.attempts[0].keys.map(keyId).sort(), ['account-ip=jwt:1|' + IP, 'account=jwt:1', 'ip=' + IP].sort());
      assert.strictEqual(throttle!.attempts[0].flow, 'login');
    });

    it('deduplicates keys that several candidates give', async () => {
      const shared = (): ThrottleKey[] => [{ kind: 'account', value: 'same' }];
      const a = strategy('a', { keys: shared, verify: () => ({ ok: false, reason: 'unsupported_credentials' }) });
      const b = strategy('b', { keys: () => [...shared(), { kind: 'account', value: 'other' }], verify: () => ({ ok: false, reason: 'invalid_credentials' }) });
      const p = await boot([a, b]);
      await p.service.authenticate(bearer('x'), ctx({ ip: undefined }));
      assert.deepStrictEqual(throttle!.attempts[0].keys.map(keyId), ['account=same', 'account=other']);
    });

    it('does not pass an invalid_credentials answer on to the next candidate', async () => {
      const { p, jwt } = await bootBearers();
      failure(await p.service.authenticate(bearer('spt_bad'), ctx()), 'invalid_credentials');
      assert.strictEqual(jwt.verifyCalls.length, 0);
    });

    it('answers unsupported_credentials when every candidate does, after counting once', async () => {
      const { p, token, jwt } = await bootBearers();
      failure(await p.service.authenticate(bearer('opaque'), ctx()), 'unsupported_credentials');
      assert.strictEqual(token.verifyCalls.length + jwt.verifyCalls.length, 2);
      assert.strictEqual(throttle!.attempts.length, 1);
      assert.deepStrictEqual(throttle!.attempts[0].keys.map(keyId), ['ip=' + IP]);
      assert.strictEqual(throttle!.succeeds.length, 0);
      assert.ok(loginFailures(p).some((e) => e.reason === 'unsupported_credentials'));
    });

    it('answers unsupported_credentials without counting or asking for keys when no listed strategy takes the kind', async () => {
      const { p, token } = await bootBearers();
      failure(await p.service.authenticate({ kind: 'kit-unknown' }, ctx()), 'unsupported_credentials');
      assert.strictEqual(throttle!.attempts.length, 0);
      assert.strictEqual(token.keyCalls.length, 0);
    });

    it('lists the registry strategies', async () => {
      const { p } = await bootBearers();
      assert.deepStrictEqual(
        p.service.strategies().map((s) => s.name),
        ['token', 'jwt'],
      );
    });
  });

  describe('throttle', () => {
    it('refuses before verify, audits throttle.block, and answers alike for known and unknown logins', async () => {
      const p = await boot(undefined, {}, { authn: { throttle: { login: { account: { free: 1, baseDelayMs: 2000, maxDelayMs: 2000 } } } } });
      await seedAlice(p);
      const local = p.strategies[0].instance as FakeStrategy;
      for (const login of [ALICE.login, 'nobody@example.test']) {
        failure(await p.service.authenticate(pw(login, WRONG), ctx()), 'invalid_credentials');
        const before = local.verifyCalls.length;
        const r = failure(await p.service.authenticate(pw(login, WRONG), ctx()), 'throttled');
        assert.strictEqual(r.retryAfterSeconds, 2, login);
        assert.strictEqual(local.verifyCalls.length, before, 'nothing verified');
      }
      assert.strictEqual(p.events.all().filter((e) => e.type === 'throttle.block').length, 2);
    });

    it('calls succeed only after a success', async () => {
      const p = await boot(undefined);
      await seedAlice(p);
      failure(await p.service.authenticate(pw(ALICE.login, WRONG), ctx()), 'invalid_credentials');
      assert.strictEqual(throttle!.succeeds.length, 0);
      success(await p.service.authenticate(pw(ALICE.login, ALICE.password), ctx()));
      assert.strictEqual(throttle!.succeeds.length, 1);
      assert.deepStrictEqual(throttle!.succeeds[0].keys, throttle!.attempts[1].keys);
      assert.strictEqual(throttle!.succeeds[0].flow, 'login');
    });

    it('adds an account-ip key next to each account key a strategy gives without one', async () => {
      const s = strategy('acct', { keys: () => [{ kind: 'account', value: 'acct-1' }], verify: () => ({ ok: false, reason: 'invalid_credentials' }) });
      const p = await boot([s]);
      await p.service.authenticate(bearer('x'), ctx());
      assert.deepStrictEqual(throttle!.attempts[0].keys.map(keyId), ['account=acct-1', `account-ip=acct-1|${IP}`, `ip=${IP}`]);
      await p.service.authenticate(bearer('x'), ctx({ ip: undefined }));
      assert.deepStrictEqual(throttle!.attempts[1].keys.map(keyId), ['account=acct-1']);
    });

    it('adds the global key only when authn.throttle.global is set', async () => {
      const s = strategy('g', { verify: () => ({ ok: false, reason: 'invalid_credentials' }) });
      let p = await boot([s]);
      await p.service.authenticate(bearer('x'), ctx());
      assert.ok(!throttle!.attempts[0].keys.some((k) => k.kind === 'global'));
      await p.dispose();
      p = await boot([strategy('g', { verify: () => ({ ok: false, reason: 'invalid_credentials' }) })], { raw: { authn: { throttle: { global: { free: 100, baseDelayMs: 1, maxDelayMs: 1 } } } } });
      await p.service.authenticate(bearer('x'), ctx());
      assert.ok(throttle!.attempts[0].keys.some((k) => k.kind === 'global'));
    });
  });

  describe('per-request strategies count failures only (K5)', () => {
    const OWNER: IdentityRef = { type: 'user', id: 'owner-1' };
    const T0 = Date.parse('2026-10-04T10:00:00Z');
    const at = (ms: number, over: Partial<AuthnContext> = {}): AuthnContext => ctx({ now: new Date(T0 + ms), purpose: 'request', ...over });
    const kidOf = (c: Credentials): string => tokenOf(c).split(':')[0];
    /** `<kid>:<secret>`, keyed by the kid as authn-keys keys its strategies; `<kid>:good` verifies. */
    const keyLike = (interactive = false) =>
      strategy('keys', {
        interactive,
        keys: (c) => [{ kind: 'account', value: `key:${kidOf(c)}` }],
        verify: (c) => (tokenOf(c).endsWith(':good') ? { ok: true, identity: OWNER, method: 'jws' } : { ok: false, reason: 'invalid_credentials' }),
      });

    async function bootKeys(config = {}, s = keyLike()): Promise<{ p: CoreParts; s: FakeStrategy }> {
      const p = await boot([s], { raw: config });
      p.identities.add({ id: OWNER.id, login: 'owner@example.test' });
      return { p, s };
    }

    it('lets parallel requests with one valid credential through, past the account and ip free counts', async () => {
      const { p, s } = await bootKeys();
      const n = DEFAULT_THROTTLE_PARAMS.login.ip!.free + 10;
      const all = await Promise.all(Array.from({ length: n }, () => p.service.authenticate(bearer('a:good'), at(0))));
      assert.strictEqual(all.filter((r) => r.status === 'success').length, n);
      assert.strictEqual(s.verifyCalls.length, n);
      assert.strictEqual(throttle!.attempts.length, 0, 'a success counts nothing');
      assert.strictEqual(throttle!.peeks.length, n);
      assert.strictEqual(throttle!.ipAttempts(IP), 0);
    });

    it('lets parallel requests with many valid credentials from one ip through', async () => {
      const { p } = await bootKeys();
      const n = DEFAULT_THROTTLE_PARAMS.login.ip!.free + 5;
      const all = await Promise.all(Array.from({ length: n }, (_, i) => p.service.authenticate(bearer(`k${i}:good`), at(0))));
      assert.strictEqual(all.filter((r) => r.status === 'success').length, n);
    });

    it('counts a failure after verify, backs off, and verifies nothing while the delay holds', async () => {
      const { p, s } = await bootKeys({ authn: { throttle: { login: { account: { free: 2, baseDelayMs: 1000, maxDelayMs: 60000 } } } } });
      failure(await p.service.authenticate(bearer('a:bad'), at(0)), 'invalid_credentials');
      failure(await p.service.authenticate(bearer('a:bad'), at(1)), 'invalid_credentials');
      const verified = s.verifyCalls.length;
      assert.strictEqual(failure(await p.service.authenticate(bearer('a:bad'), at(2)), 'throttled').retryAfterSeconds, 1);
      assert.strictEqual(failure(await p.service.authenticate(bearer('a:good'), at(3)), 'throttled').retryAfterSeconds, 1, 'the owner waits out the same delay');
      assert.strictEqual(s.verifyCalls.length, verified, 'nothing verified');
      failure(await p.service.authenticate(bearer('a:bad'), at(1001)), 'invalid_credentials');
      assert.strictEqual(failure(await p.service.authenticate(bearer('a:bad'), at(1002)), 'throttled').retryAfterSeconds, 2, 'the delay doubles');
      assert.strictEqual(p.events.all().filter((e) => e.type === 'throttle.block').length, 3);
    });

    it('answers throttled to the failures of a parallel burst beyond the free slots, and backs off after it', async () => {
      const { p } = await bootKeys({ authn: { throttle: { login: { account: { free: 2, baseDelayMs: 1000, maxDelayMs: 60000 } } } } });
      const all = await Promise.all(Array.from({ length: 10 }, () => p.service.authenticate(bearer('a:bad'), at(0))));
      assert.strictEqual(all.filter((r) => r.status === 'failure' && r.reason === 'invalid_credentials').length, 2);
      assert.strictEqual(all.filter((r) => r.status === 'failure' && r.reason === 'throttled').length, 8);
      failure(await p.service.authenticate(bearer('a:good'), at(1)), 'throttled');
    });

    it('counts a verified credential that the identity status refuses', async () => {
      const { p } = await bootKeys({ authn: { throttle: { login: { account: { free: 1, baseDelayMs: 1000, maxDelayMs: 1000 } } } } });
      p.identities.setStatus(OWNER, { banned: true });
      failure(await p.service.authenticate(bearer('a:good'), at(0)), 'invalid_credentials');
      assert.strictEqual(throttle!.attempts.length, 1);
      failure(await p.service.authenticate(bearer('a:good'), at(1)), 'throttled');
    });

    it('counts every kind of failure, not only invalid_credentials', async () => {
      const outcomes: Record<string, () => StrategyOutcome> = {
        throws: () => {
          throw new RangeError('strategy down');
        },
        broken: () => ({}) as StrategyOutcome,
        revoked: () => ({ ok: false, reason: 'revoked' }),
        expired: () => ({ ok: false, reason: 'expired' }),
        unsupported: () => ({ ok: false, reason: 'unsupported_credentials' }),
        unlinked: () => ({ ok: true, external: { provider: 'kit-p', subject: 'nobody' }, method: 'jwt' }),
        storefail: () => ({ ok: true, identity: { type: 'user', id: 'boom' }, method: 'token' }),
      };
      const s = strategy('every', { keys: (c) => [{ kind: 'account', value: tokenOf(c) }], verify: (c) => outcomes[tokenOf(c)]() });
      const p = await boot([s]);
      const status = p.identities.status.bind(p.identities);
      p.identities.status = async (id: IdentityRef) => {
        if (id.id === 'boom') throw new Error('store down');
        return status(id);
      };
      for (const [i, name] of Object.keys(outcomes).entries()) {
        assert.strictEqual((await p.service.authenticate(bearer(name), at(i))).status, 'failure', name);
        assert.strictEqual(throttle!.attempts.length, i + 1, `${name} is counted`);
      }
      assert.strictEqual(throttle!.ipAttempts(IP), Object.keys(outcomes).length);
    });

    it("never clears other credentials' failures from the ip key on a success (H31)", async () => {
      const { p } = await bootKeys({ authn: { throttle: { login: { ip: { free: 3, baseDelayMs: 1000, maxDelayMs: 300000 } } } } });
      for (let i = 0; i < 3; i++) {
        failure(await p.service.authenticate(bearer(`victim${i}:guess`), at(i * 2)), 'invalid_credentials');
        if (i < 2) success(await p.service.authenticate(bearer('own:good'), at(i * 2 + 1)));
      }
      assert.strictEqual(throttle!.ipAttempts(IP), 3);
      failure(await p.service.authenticate(bearer('victim3:guess'), at(10)), 'throttled');
      failure(await p.service.authenticate(bearer('own:good'), at(11)), 'throttled');
    });

    it("takes only the answering credential's own failures off the ip key (D8)", async () => {
      const { p } = await bootKeys();
      failure(await p.service.authenticate(bearer('own:bad'), at(0)), 'invalid_credentials');
      failure(await p.service.authenticate(bearer('own:bad'), at(1)), 'invalid_credentials');
      failure(await p.service.authenticate(bearer('victim:guess'), at(2)), 'invalid_credentials');
      assert.strictEqual(throttle!.ipAttempts(IP), 3);
      success(await p.service.authenticate(bearer('own:good'), at(3)));
      assert.strictEqual(throttle!.ipAttempts(IP), 1);
      assert.deepStrictEqual(throttle!.succeeds[0].keys.map(keyId), ['account=key:own', `account-ip=key:own|${IP}`, `ip=${IP}`]);
    });

    it('counts before verify when an interactive strategy is among the candidates', async () => {
      const p = await boot([keyLike(), strategy('login', { interactive: true, verify: () => ({ ok: false, reason: 'unsupported_credentials' }) })]);
      p.identities.add({ id: OWNER.id, login: 'owner@example.test' });
      const free = DEFAULT_THROTTLE_PARAMS.login.account!.free;
      const all = await Promise.all(Array.from({ length: free + 3 }, () => p.service.authenticate(bearer('a:good'), at(0))));
      assert.strictEqual(all.filter((r) => r.status === 'success').length, free);
      assert.strictEqual(throttle!.peeks.length, 0);
    });

    it('keeps counting interactive logins before verify', async () => {
      const { p, s } = await bootKeys({}, keyLike(true));
      const free = DEFAULT_THROTTLE_PARAMS.login.account!.free;
      const all = await Promise.all(Array.from({ length: free + 3 }, () => p.service.authenticate(bearer('a:good'), at(0, { purpose: 'login' }))));
      assert.strictEqual(all.filter((r) => r.status === 'success').length, free);
      assert.strictEqual(all.filter((r) => r.status === 'failure' && r.reason === 'throttled').length, 3);
      assert.strictEqual(s.verifyCalls.length, free);
    });

    it('counts before verify, and warns at boot, when the throttle cannot peek', async () => {
      class NoPeek extends AuthnThrottle {
        constructor(private readonly inner: MemoryAuthnThrottle) {
          super();
        }
        attempt(keys: readonly ThrottleKey[], flow: ThrottleFlow, c: AuthnContext) {
          return this.inner.attempt(keys, flow, c);
        }
        succeed(keys: readonly ThrottleKey[], flow: ThrottleFlow) {
          return this.inner.succeed(keys, flow);
        }
      }
      parts = await buildCore({}, { strategies: [spec(keyLike())], throttle: (c) => new NoPeek(new MemoryAuthnThrottle(c)) });
      const p = parts;
      p.identities.add({ id: OWNER.id, login: 'owner@example.test' });
      const free = DEFAULT_THROTTLE_PARAMS.login.account!.free;
      const all = await Promise.all(Array.from({ length: free + 3 }, () => p.service.authenticate(bearer('a:good'), at(0))));
      assert.strictEqual(all.filter((r) => r.status === 'success').length, free);
      assert.ok(TestLog.lines.some((l) => l.includes('the throttle has no peek()')), TestLog.lines.join('\n'));
    });
  });

  describe('a success takes only its own account off the ip key (D8)', () => {
    const passwordLike = (name: string, accountOf: (login: string) => string, accountIpOf: ((account: string, ip: string) => string) | null, owns: boolean): FakeStrategy =>
      strategy(name, {
        kinds: ['password'],
        interactive: true,
        keys: (c, x) => {
          const account = accountOf(String((c as { login?: unknown }).login));
          return [{ kind: 'account', value: account }, ...(accountIpOf ? [{ kind: 'account-ip', value: accountIpOf(account, x.ip ?? '') }] : [])];
        },
        verify: (c) => {
          if (!owns) return { ok: false, reason: 'unsupported_credentials' };
          const { login, password } = c as { login?: unknown; password?: unknown };
          return login === 'mallory' && password === 'right' ? { ok: true, identity: { type: 'user', id: 'mallory' }, method: 'password' } : { ok: false, reason: 'invalid_credentials' };
        },
      });
    const plain = (a: string, ip: string): string => `${a}|${ip}`;

    /** 20 failures on 20 other accounts from one ip (ip free = 20), then 5 own successes: the ip attempts after each stage. */
    async function stuffThenSucceed(strategies: FakeStrategy[]): Promise<number[]> {
      const p = await boot(strategies);
      p.identities.add({ id: 'mallory', login: 'mallory' });
      let now = Date.parse('2026-10-03T10:00:00Z');
      const run = async (login: string, password: string): Promise<AuthenticationResult> => {
        for (;;) {
          const r = await p.service.authenticate(pw(login, password), ctx({ now: new Date(now) }));
          if (r.status === 'failure' && r.reason === 'throttled') {
            now += r.retryAfterSeconds! * 1000;
            continue;
          }
          now += 1;
          return r;
        }
      };
      for (let i = 0; i < 20; i++) failure(await run(`victim${i}`, 'guess'), 'invalid_credentials');
      const stuffed = throttle!.ipAttempts(IP);
      success(await run('mallory', 'right'));
      const once = throttle!.ipAttempts(IP);
      for (let i = 0; i < 4; i++) success(await run('mallory', 'right'));
      return [stuffed, once, throttle!.ipAttempts(IP)];
    }

    it('keeps the failures when the strategy writes account-ip in its own format', async () => {
      assert.deepStrictEqual(
        await stuffThenSucceed([
          passwordLike(
            'local',
            (l) => l,
            (a, ip) => `${ip}/${a}`,
            true,
          ),
        ]),
        [20, 20, 20],
      );
      const keys = throttle!.attempts[0].keys.map(keyId);
      assert.ok(!keys.includes(`account-ip=${IP}/victim0`), 'the strategy own account-ip is ignored (D8b)');
      assert.ok(keys.includes(`account-ip=victim0|${IP}`), 'the service builds account-ip itself (D8b)');
    });

    it('builds account-ip itself, so a strategy account-ip without the ip clears nothing on another ip (D8b)', async () => {
      const s = passwordLike(
        'local',
        (l) => l,
        (a) => `acct:${a}`,
        true,
      );
      const p = await boot([s]);
      p.identities.add({ id: 'mallory', login: 'mallory' });
      const OTHER_IP = '203.0.113.9';
      let now = Date.parse('2026-10-03T10:00:00Z');
      const run = async (login: string, password: string, ip: string): Promise<AuthenticationResult> => {
        for (;;) {
          const r = await p.service.authenticate(pw(login, password), ctx({ now: new Date(now), ip }));
          if (r.status === 'failure' && r.reason === 'throttled') {
            now += r.retryAfterSeconds! * 1000;
            continue;
          }
          now += 1;
          return r;
        }
      };
      for (let i = 0; i < 20; i++) failure(await run(`victim${i}`, 'guess', IP), 'invalid_credentials');
      for (let i = 0; i < 5; i++) failure(await run('mallory', 'wrong', OTHER_IP), 'invalid_credentials');
      success(await run('mallory', 'right', IP));
      assert.strictEqual(throttle!.ipAttempts(IP), 20);
      assert.ok(!throttle!.attempts.some((a) => a.keys.some((k) => k.value.startsWith('acct:'))));
    });

    it('keeps the failures with two password candidates, the first answering', async () => {
      assert.deepStrictEqual(await stuffThenSucceed([passwordLike('local', (l) => l, plain, true), passwordLike('ldap', (l) => `ldap:${l}`, plain, false)]), [20, 20, 20]);
      assert.ok(
        throttle!.attempts[0].keys.some((k) => k.value === 'ldap:victim0'),
        'both candidates count',
      );
      assert.ok(!throttle!.succeeds[0].keys.some((k) => k.value.startsWith('ldap:')), 'succeed gets only the answering strategy keys');
    });

    it('keeps the failures when the first candidate gives keys and then answers unsupported_credentials', async () => {
      assert.deepStrictEqual(await stuffThenSucceed([passwordLike('ldap', (l) => `ldap:${l}`, plain, false), passwordLike('local', (l) => l, plain, true)]), [20, 20, 20]);
    });

    it('adds account-ip for each candidate that gave none, and passes the answering one to succeed', async () => {
      const p = await boot([passwordLike('ldap', (l) => `ldap:${l}`, null, false), passwordLike('local', (l) => l, null, true)]);
      p.identities.add({ id: 'mallory', login: 'mallory' });
      success(await p.service.authenticate(pw('mallory', 'right'), ctx()));
      assert.deepStrictEqual(throttle!.attempts[0].keys.map(keyId), ['account=ldap:mallory', `account-ip=ldap:mallory|${IP}`, 'account=mallory', `account-ip=mallory|${IP}`, `ip=${IP}`]);
      assert.deepStrictEqual(throttle!.succeeds[0].keys.map(keyId), ['account=mallory', `account-ip=mallory|${IP}`, `ip=${IP}`]);
    });
  });

  describe('strategy failures', () => {
    it('turns a throwing strategy into invalid_credentials and audits the error class only', async () => {
      const thrower = strategy('thrower', {
        verify: () => {
          throw new RangeError('bad token spt_secret_value');
        },
      });
      const next = strategy('next', { verify: () => ({ ok: true, identity: { type: 'user', id: 'u' }, method: 'token' }) });
      const p = await boot([thrower, next]);
      failure(await p.service.authenticate(bearer('spt_secret_value'), ctx()), 'invalid_credentials');
      assert.strictEqual(next.verifyCalls.length, 0, 'a throw is final');
      assert.strictEqual(throttle!.succeeds.length, 0);
      const e = loginFailures(p).find((x) => x.reason === 'strategy_error');
      assert.ok(e, JSON.stringify(p.events.all()));
      assert.deepStrictEqual(e.data, { error: 'RangeError' });
      assert.ok(!JSON.stringify(p.events.all()).includes('spt_secret_value'));
    });

    it('turns throwing or malformed throttle keys into invalid_credentials without verifying', async () => {
      const bad = [
        strategy('k1', {
          keys: () => {
            throw new Error('boom');
          },
          verify: () => ({ ok: true, identity: { type: 'user', id: 'u' }, method: 'token' }),
        }),
        strategy('k2', { keys: () => [{ kind: 'account', value: 7 as unknown as string }], verify: () => ({ ok: true, identity: { type: 'user', id: 'u' }, method: 'token' }) }),
      ];
      for (const s of bad) {
        const p = await boot([s]);
        failure(await p.service.authenticate(bearer('x'), ctx()), 'invalid_credentials');
        assert.strictEqual(s.verifyCalls.length, 0);
        assert.ok(loginFailures(p).some((e) => e.reason === 'strategy_error'));
        await p.dispose();
        parts = undefined;
      }
    });

    it('turns a success with neither or both of identity and external into invalid_credentials (D5)', async () => {
      const outcomes: StrategyOutcome[] = [
        { ok: true, method: 'token' },
        { ok: true, method: 'token', identity: { type: 'user', id: 'u' }, external: { provider: 'p', subject: 's' } },
        { ok: true, method: '', identity: { type: 'user', id: 'u' } },
        { ok: false, reason: 'made_up' as never },
        { ok: false, reason: 'throttled' },
      ];
      for (const o of outcomes) {
        const p = await boot([strategy('odd', { verify: () => o })]);
        p.identities.add({ id: 'u', login: 'u@example.test' });
        failure(await p.service.authenticate(bearer('x'), ctx()), 'invalid_credentials');
        assert.ok(
          loginFailures(p).some((e) => e.reason === 'strategy_contract'),
          JSON.stringify(o),
        );
        assert.strictEqual(throttle!.succeeds.length, 0);
        await p.dispose();
        parts = undefined;
      }
    });

    it('passes a strategy failure reason through and audits it', async () => {
      const p = await boot([strategy('exp', { verify: () => ({ ok: false, reason: 'expired' }) })]);
      failure(await p.service.authenticate(bearer('x'), ctx()), 'expired');
      assert.ok(p.events.all().some((e) => e.outcome === 'failure' && e.reason === 'expired' && e.strategy === 'exp'));
    });
  });

  describe('identity checks', () => {
    const AGENT: IdentityRef = { type: 'agent', id: 'agent-1' };

    async function bootAgent(ownerStatus: object): Promise<{ p: CoreParts; owner: IdentityRef }> {
      const owner: IdentityRef = { type: 'user', id: 'owner-1' };
      const s = strategy('agent', { verify: () => ({ ok: true, identity: AGENT, method: 'token', delegation: { onBehalfOf: owner, mode: 'inherit' }, ceiling: { reason: 'out_of_scope' } }) });
      const p = await boot([s]);
      p.identities.add({ id: owner.id, login: 'owner@example.test', status: ownerStatus });
      return { p, owner };
    }

    it('checks the status of the identity a delegation acts for (D4)', async () => {
      const { p, owner } = await bootAgent({});
      const r = success(await p.service.authenticate(bearer('x'), ctx({ purpose: 'request' })));
      assert.deepStrictEqual(r.identity, AGENT);
      assert.deepStrictEqual(r.delegation, { onBehalfOf: owner, mode: 'inherit' });
      assert.deepStrictEqual(p.identities.calls.status, [owner]);
    });

    it('refuses a delegation whose owner is banned, keeping the reason in audit (D4)', async () => {
      const { p } = await bootAgent({ banned: true });
      failure(await p.service.authenticate(bearer('x'), ctx({ purpose: 'request' })), 'invalid_credentials');
      assert.ok(loginFailures(p).some((e) => e.reason === 'banned'));
      assert.strictEqual(throttle!.succeeds.length, 0);
    });

    it('refuses an unknown identity with invalid_credentials', async () => {
      const p = await boot([strategy('ghost', { verify: () => ({ ok: true, identity: { type: 'user', id: 'nobody' }, method: 'token' }) })]);
      failure(await p.service.authenticate(bearer('x'), ctx()), 'invalid_credentials');
      assert.ok(loginFailures(p).some((e) => e.reason === 'unknown_identity'));
    });

    it('asks no status for a service identity, which its strategy vouches for (D4b)', async () => {
      const svc: IdentityRef = { type: 'service', id: 'svc-1' };
      const p = await boot([strategy('keys', { kinds: ['jws-assertion'], verify: () => ({ ok: true, identity: svc, method: 'jws' }) })]);
      assert.deepStrictEqual(success(await p.service.authenticate({ kind: 'jws-assertion', jws: 'x' }, ctx({ purpose: 'request' }))).identity, svc);
      assert.deepStrictEqual(p.identities.calls.status, []);
    });

    it('asks no status for a delegation on behalf of a service identity (D4b)', async () => {
      const owner: IdentityRef = { type: 'service', id: 'svc-1' };
      const p = await boot([strategy('agent', { verify: () => ({ ok: true, identity: AGENT, method: 'token', delegation: { onBehalfOf: owner, mode: 'intersect' } }) })]);
      success(await p.service.authenticate(bearer('x'), ctx({ purpose: 'request' })));
      assert.deepStrictEqual(p.identities.calls.status, []);
    });

    it('asks the status of every subject type but service and agent, so an unknown type fails closed (D4b)', async () => {
      const p = await boot([strategy('odd', { verify: (c) => ({ ok: true, identity: { type: tokenOf(c), id: 'u-1' }, method: 'token' }) })]);
      p.identities.add({ id: 'u-1', login: 'u' });
      p.identities.add({ type: 'customer', id: 'u-1', login: 'c' });
      failure(await p.service.authenticate(bearer('User'), ctx({ purpose: 'request' })), 'invalid_credentials');
      assert.ok(loginFailures(p).some((e) => e.reason === 'unknown_identity'));
      success(await p.service.authenticate(bearer('customer'), ctx({ purpose: 'request' })));
      assert.deepStrictEqual(p.identities.calls.status, [
        { type: 'User', id: 'u-1' },
        { type: 'customer', id: 'u-1' },
      ]);
    });

    it('issues sessions only to user identities (D12)', async () => {
      const svc: IdentityRef = { type: 'service', id: 'svc-1' };
      const p = await boot([strategy('svc-login', { kinds: ['password'], interactive: true, verify: () => ({ ok: true, identity: svc, method: 'password' }) })]);
      p.identities.add({ type: 'service', id: svc.id, login: 'svc' });
      failure(await p.service.authenticate(pw('svc', 'x'), ctx()), 'invalid_credentials');
      assert.ok(loginFailures(p).some((e) => e.reason === 'non_user_session'));
      assert.deepStrictEqual(await p.sessions.storage.storedKeys(), []);
      assert.strictEqual(throttle!.succeeds.length, 0);
    });
  });

  describe('linking', () => {
    const subject = (over: object = {}) => ({ provider: 'kit-idp', subject: 'sub-1', email: ALICE.login, emailVerified: true, ...over });
    const external = { kind: 'external', provider: 'kit-idp', payload: { subject: 'sub-1' } } as Credentials;

    async function bootLinking(linking: object, sub = subject()): Promise<CoreParts> {
      const p = await boot(undefined, {}, { authn: { linking } });
      p.externalSubjects.set(sub.subject, sub);
      return p;
    }

    it('logs a linked subject in as its identity', async () => {
      const p = await bootLinking({});
      const a = await seedAlice(p);
      await p.links.link(a, subject());
      assert.deepStrictEqual(success(await p.service.authenticate(external, ctx())).identity, a);
    });

    it('links by verified email only when authn.linking.byVerifiedEmail is on', async () => {
      let p = await bootLinking({});
      await seedAlice(p);
      failure(await p.service.authenticate(external, ctx()), 'not_linked');
      await p.dispose();
      p = await bootLinking({ byVerifiedEmail: true }, subject({ emailVerified: false }));
      await seedAlice(p);
      failure(await p.service.authenticate(external, ctx()), 'not_linked');
      await p.dispose();
      p = await bootLinking({ byVerifiedEmail: true });
      const a = await seedAlice(p);
      assert.deepStrictEqual(success(await p.service.authenticate(external, ctx())).identity, a);
      assert.strictEqual(p.links.links.length, 1);
      assert.ok(p.events.all().some((e) => e.type === 'identity.link' && e.outcome === 'success'));
    });

    it('matches a verified email against the stored email, never a login name (I1)', async () => {
      const p = await bootLinking({ byVerifiedEmail: true }, subject({ email: 'boss@corp.test' }));
      p.identities.add({ login: 'boss@corp.test', email: 'real-boss@other.test' });
      failure(await p.service.authenticate(external, ctx()), 'not_linked');
      assert.strictEqual(p.links.links.length, 0);
      assert.deepStrictEqual(await p.sessions.storage.storedKeys(), []);
    });

    it('matches the stored email without regard to case', async () => {
      const p = await bootLinking({ byVerifiedEmail: true }, subject({ email: 'alice@example.test' }));
      const a = p.identities.add({ login: 'alice', email: 'Alice@Example.test' });
      assert.deepStrictEqual(success(await p.service.authenticate(external, ctx())).identity, a);
      assert.strictEqual(p.links.links.length, 1);
    });

    it('folds ASCII letters only: the Kelvin sign does not match k (task 6 R2)', async () => {
      const p = await bootLinking({ byVerifiedEmail: true }, subject({ email: 'Kim@corp.test' }));
      p.identities.add({ login: 'kim', email: 'kim@corp.test' });
      failure(await p.service.authenticate(external, ctx()), 'not_linked');
      assert.strictEqual(p.links.links.length, 0);
    });

    it('does not match an identity that has no stored email', async () => {
      const p = await bootLinking({ byVerifiedEmail: true });
      p.identities.add({ login: ALICE.login });
      failure(await p.service.authenticate(external, ctx()), 'not_linked');
      assert.strictEqual(p.links.links.length, 0);
    });

    it('fails closed when the stored email cannot be read', async () => {
      const p = await bootLinking({ byVerifiedEmail: true });
      await seedAlice(p);
      p.identities.display = async () => {
        throw new RangeError('store down');
      };
      failure(await p.service.authenticate(external, ctx()), 'invalid_credentials');
      assert.strictEqual(p.links.links.length, 0);
      assert.ok(loginFailures(p).some((e) => e.reason === 'store_error' && (e.data as { error?: string } | undefined)?.error === 'RangeError'));
    });

    it('creates no link for an identity whose status refuses the login', async () => {
      const p = await bootLinking({ byVerifiedEmail: true });
      await seedAlice(p, { banned: true });
      failure(await p.service.authenticate(external, ctx()), 'invalid_credentials');
      assert.strictEqual(p.links.links.length, 0);
    });

    it('provisions an unlinked subject when authn.linking.jit is on', async () => {
      const p = await bootLinking({ jit: true }, subject({ email: 'new@example.test' }));
      const r = success(await p.service.authenticate(external, ctx()));
      assert.strictEqual(p.identities.calls.provision.length, 1);
      assert.deepStrictEqual(p.links.links[0].identity, r.identity);
    });

    it('links a just provisioned identity even when its status refuses, so a retry does not provision again', async () => {
      const p = await bootLinking({ jit: true }, subject({ email: 'new@example.test' }));
      let provisioned = 0;
      p.identities.provision = async (ext: ExternalSubject) => {
        provisioned++;
        return p.identities.add({ login: ext.email ?? ext.subject, email: ext.email, status: { active: false } });
      };
      failure(await p.service.authenticate(external, ctx()), 'invalid_credentials');
      failure(await p.service.authenticate(external, ctx()), 'invalid_credentials');
      assert.strictEqual(provisioned, 1);
      assert.strictEqual(p.links.links.length, 1);
      assert.ok(loginFailures(p).every((e) => e.reason === 'inactive'));
    });

    it('answers not_linked without a link store', async () => {
      const p = await boot(undefined, { omit: ['IdentityLinkStore'] }, { authn: { linking: { jit: true } } });
      p.externalSubjects.set('sub-1', subject());
      failure(await p.service.authenticate(external, ctx()), 'not_linked');
    });
  });

  describe('external login hooks (RFC N10-1)', () => {
    const subject = (over: object = {}) => ({ provider: 'kit-idp', subject: 'sub-1', email: ALICE.login, emailVerified: true, ...over });
    const external = { kind: 'external', provider: 'kit-idp', payload: { subject: 'sub-1' } } as Credentials;

    interface HookCall {
      readonly hook: string;
      readonly identity: IdentityRef;
      readonly external: ExternalSubject;
      readonly sessionsAtCall: number;
    }

    /** Two hooks in registration order; `failing` names the one that throws. */
    async function bootHooks(o: { linking?: object; failing?: 'first' | 'second'; strategies?: FakeStrategy[]; broken?: boolean } = {}) {
      const calls: HookCall[] = [];
      let p!: CoreParts;
      const record = async (hook: 'first' | 'second', identity: IdentityRef, ext: ExternalSubject): Promise<void> => {
        calls.push({ hook, identity, external: ext, sessionsAtCall: (await p.sessions.storage.storedKeys()).length });
        if (o.failing === hook) throw new RangeError('group sync down');
      };
      class FirstHook extends ExternalLoginHook {
        afterLogin = (identity: IdentityRef, ext: ExternalSubject) => record('first', identity, ext);
      }
      class SecondHook extends ExternalLoginHook {
        afterLogin = (identity: IdentityRef, ext: ExternalSubject) => record('second', identity, ext);
      }
      class Broken extends ExternalLoginHook {
        constructor() {
          super();
          throw new TypeError('cannot build');
        }
        async afterLogin(): Promise<void> {}
      }
      p = await boot(o.strategies, { register: (c) => [FirstHook, SecondHook, ...(o.broken ? [Broken] : [])].forEach((h) => c.register(h).as(ExternalLoginHook)) }, { authn: { linking: o.linking ?? {} } });
      p.externalSubjects.set('sub-1', subject());
      return { p, calls };
    }

    it('runs every hook with the identity and the mapped subject before the session is issued', async () => {
      const { p, calls } = await bootHooks();
      const a = await seedAlice(p);
      await p.links.link(a, subject());
      const r = success(await p.service.authenticate(external, ctx()));
      assert.deepStrictEqual(r.identity, a);
      assert.deepStrictEqual(
        calls.map((c) => c.hook),
        ['first', 'second'],
      );
      for (const c of calls) {
        assert.deepStrictEqual(c.identity, a);
        assert.deepStrictEqual(c.external, subject());
        assert.strictEqual(c.sessionsAtCall, 0, 'no session exists while a hook runs');
      }
      assert.strictEqual(throttle!.succeeds.length, 1);
    });

    for (const failing of ['first', 'second'] as const) {
      it(`a throwing ${failing} hook fails the login: no session, no success event, no throttle reset`, async () => {
        const { p, calls } = await bootHooks({ failing });
        const a = await seedAlice(p);
        await p.links.link(a, subject());
        failure(await p.service.authenticate(external, ctx()), 'invalid_credentials');
        assert.deepStrictEqual(
          calls.map((c) => c.hook),
          failing === 'first' ? ['first'] : ['first', 'second'],
        );
        assert.deepStrictEqual(await p.sessions.storage.storedKeys(), []);
        assert.strictEqual(throttle!.succeeds.length, 0);
        assert.ok(!p.events.all().some((e) => e.outcome === 'success'), JSON.stringify(p.events.all()));
        const refused = loginFailures(p);
        assert.strictEqual(refused.length, 1);
        assert.deepStrictEqual({ type: refused[0].type, reason: refused[0].reason, strategy: refused[0].strategy, identity: refused[0].identity, data: refused[0].data }, { type: 'login', reason: 'hook_error', strategy: 'fake-idp', identity: a, data: { error: 'RangeError' } });
      });
    }

    it('a throwing hook issues no pending session either', async () => {
      const { p } = await bootHooks({ failing: 'first' });
      const a = await seedAlice(p);
      p.step.enrol(a);
      await p.links.link(a, subject());
      failure(await p.service.authenticate(external, ctx()), 'invalid_credentials');
      assert.deepStrictEqual(await p.sessions.storage.storedKeys(), []);
      assert.ok(!p.events.all().some((e) => e.type === 'mfa.challenge'));
    });

    it('a hook that cannot be built fails the login closed', async () => {
      const { p } = await bootHooks({ broken: true });
      const a = await seedAlice(p);
      await p.links.link(a, subject());
      failure(await p.service.authenticate(external, ctx()), 'invalid_credentials');
      assert.deepStrictEqual(await p.sessions.storage.storedKeys(), []);
      assert.ok(loginFailures(p).some((e) => e.reason === 'hook_error'));
    });

    it('a login a hook refuses creates no link by verified email', async () => {
      const { p } = await bootHooks({ linking: { byVerifiedEmail: true }, failing: 'second' });
      await seedAlice(p);
      failure(await p.service.authenticate(external, ctx()), 'invalid_credentials');
      assert.strictEqual(p.links.links.length, 0);
      assert.ok(!p.events.all().some((e) => e.type === 'identity.link'));
    });

    it('runs no hook when the status refuses the identity or the subject is not linked', async () => {
      const { p, calls } = await bootHooks();
      const a = await seedAlice(p, { banned: true });
      failure(await p.service.authenticate(external, ctx()), 'not_linked');
      await p.links.link(a, subject());
      failure(await p.service.authenticate(external, ctx()), 'invalid_credentials');
      assert.strictEqual(calls.length, 0);
    });

    it('runs no hook for an identity outcome or a per-request external outcome', async () => {
      const OWNER: IdentityRef = { type: 'user', id: 'owner-1' };
      const perRequest = strategy('jwt', { verify: (c) => (tokenOf(c) === 'ext' ? { ok: true, external: { provider: 'kit-idp', subject: 'sub-1' }, method: 'jwt' } : { ok: true, identity: OWNER, method: 'jwt' }) });
      const { p, calls } = await bootHooks({ strategies: [perRequest] });
      p.identities.add({ id: OWNER.id, login: 'owner@example.test' });
      const a = await seedAlice(p);
      await p.links.link(a, subject());
      assert.deepStrictEqual(success(await p.service.authenticate(bearer('ext'), ctx({ purpose: 'request' }))).identity, a);
      success(await p.service.authenticate(bearer('own'), ctx({ purpose: 'request' })));
      assert.strictEqual(calls.length, 0);
    });
  });

  describe('results and events', () => {
    it('gives a per-request success no session and audits token.use or key.use', async () => {
      const id: IdentityRef = { type: 'user', id: 'u-1' };
      const tok = strategy('tok', { verify: () => ({ ok: true, identity: id, method: 'token' }) });
      const keys = strategy('keys', { kinds: ['jws-assertion'], verify: () => ({ ok: true, identity: id, method: 'jws' }) });
      const p = await boot([tok, keys], { raw: { authn: { audit: { sampleUse: 1 } } } });
      p.identities.add({ id: id.id, login: 'u' });
      const r = success(await p.service.authenticate(bearer('x'), ctx({ purpose: 'request' })));
      assert.strictEqual(r.session, undefined);
      success(await p.service.authenticate({ kind: 'jws-assertion', jws: 'x' }, ctx({ purpose: 'request' })));
      assert.deepStrictEqual(
        p.events.all().map((e) => `${e.type}:${e.strategy}`),
        ['token.use:tok', 'key.use:keys'],
      );
      assert.deepStrictEqual(await p.sessions.storage.storedKeys(), []);
    });

    it('never puts the login, the password or the raw session id in events', async () => {
      const p = await boot(undefined);
      await seedAlice(p);
      await p.service.authenticate(pw(ALICE.login, WRONG), ctx());
      await p.service.authenticate(pw('nobody@example.test', WRONG), ctx());
      const r = success(await p.service.authenticate(pw(ALICE.login, ALICE.password), ctx()));
      const json = JSON.stringify(p.events.all());
      for (const secret of [ALICE.login, 'nobody@example.test', ALICE.password, WRONG, r.session!.id]) assert.ok(!json.includes(secret), secret);
      const issue = p.events.all().find((e) => e.type === 'session.issue');
      assert.strictEqual(issue?.session, r.facts.sessionHandle);
    });

    it('passes ceiling, delegation and attributes through', async () => {
      const id: IdentityRef = { type: 'user', id: 'u-1' };
      const p = await boot([strategy('tok', { verify: () => ({ ok: true, identity: id, method: 'token', ceiling: { permissions: ['file:read'] }, attributes: { profile: 'p1' } }) })]);
      p.identities.add({ id: id.id, login: 'u' });
      const r = success(await p.service.authenticate(bearer('x'), ctx({ purpose: 'request' })));
      assert.deepStrictEqual(r.ceiling, { permissions: ['file:read'] });
      assert.deepStrictEqual(r.attributes, { profile: 'p1' });
      assert.deepStrictEqual(r.facts, { method: 'token', strategy: 'tok', assurance: 'aal1', mfa: [] });
    });

    it('issues a pending session and audits mfa.challenge when the policy requires steps', async () => {
      const p = await boot(undefined);
      const a = await seedAlice(p);
      p.step.enrol(a);
      const r = await p.service.authenticate(pw(ALICE.login, ALICE.password), ctx());
      assert.strictEqual(r.status, 'mfa_required', JSON.stringify(r));
      assert.deepStrictEqual([...(r as { steps: readonly string[] }).steps], [p.step.name]);
      assert.strictEqual((r as { pending: { state: string } }).pending.state, 'pending');
      const challenge = p.events.all().find((e) => e.type === 'mfa.challenge');
      assert.ok(challenge?.session && challenge.session !== (r as { pending: { id: string } }).pending.id);
      assert.ok(!p.events.all().some((e) => e.type === 'login' && e.outcome === 'success'));
    });

    it('answers invalid_credentials, not a rejection, when the MFA policy fails after the password verified (A02)', async () => {
      const broken = new StubStep('broken', { enrolled: false });
      broken.enrolled = async () => {
        throw new RangeError('mfa store down');
      };
      const p = await boot(undefined, withSteps([broken]));
      await seedAlice(p);
      failure(await p.service.authenticate(pw(ALICE.login, ALICE.password), ctx()), 'invalid_credentials');
      const e = p.events.all().find((x) => x.outcome === 'failure');
      assert.deepStrictEqual({ type: e?.type, reason: e?.reason, data: e?.data }, { type: 'login', reason: 'policy_error', data: { error: 'RangeError' } });
      assert.deepStrictEqual(await p.sessions.storage.storedKeys(), []);
    });

    it('answers invalid_credentials and false, not a rejection, when a store fails after the credentials verified (A02)', async () => {
      const p = await boot(undefined);
      const a = await seedAlice(p);
      const session = await p.sessions.issue(a, { method: 'password', strategy: 'local', assurance: 'aal1', mfa: [], authenticatedAt: new Date() });
      p.identities.status = async () => {
        throw new RangeError('users store down');
      };
      failure(await p.service.authenticate(pw(ALICE.login, ALICE.password), ctx()), 'invalid_credentials');
      assert.strictEqual(await p.service.reauthenticate(session, pw(ALICE.login, ALICE.password), ctx({ purpose: 'reauth', session })), false);
      assert.deepStrictEqual(
        p.events
          .all()
          .filter((x) => x.outcome === 'failure')
          .map((x) => `${x.type}:${x.reason}:${String(x.data?.error)}`),
        ['login:store_error:RangeError', 'reauth:store_error:RangeError'],
      );
    });
  });

  /** The identity keys of the mfa and reauth flows (D14). */
  const identityKeys = (id: IdentityRef, ip: string | undefined): string[] => [`account=${id.id}`, `account-ip=${id.id}|${ip ?? ''}`, ...(ip ? [`ip=${ip}`] : [])];
  const flowCalls = (calls: { keys: ThrottleKey[]; flow: ThrottleFlow }[], flow: ThrottleFlow): string[][] => calls.filter((x) => x.flow === flow).map((x) => x.keys.map(keyId));

  describe('completeMfa', () => {
    const NOW = new Date('2026-10-03T10:00:00Z');

    async function pendingAlice(p: CoreParts): Promise<{ a: IdentityRef; pending: SessionHandle }> {
      const a = await seedAlice(p);
      p.step.enrol(a);
      const r = await p.service.authenticate(pw(ALICE.login, ALICE.password), ctx());
      assert.strictEqual(r.status, 'mfa_required', JSON.stringify(r));
      return { a, pending: (r as Pending).pending };
    }

    it('elevates the pending session to aal2 with the passed step, rotates it, and audits mfa.verify and login', async () => {
      const p = await boot(undefined);
      const { a, pending } = await pendingAlice(p);
      p.events.clear();
      const r = success(await p.service.completeMfa(pending, p.step.name, p.step.nextCode(a), ctx()));
      assert.deepStrictEqual(r.identity, a);
      assert.strictEqual(r.facts.assurance, 'aal2');
      assert.deepStrictEqual([...r.facts.mfa], [p.step.name]);
      assert.strictEqual(r.facts.method, 'password');
      assert.strictEqual(r.facts.strategy, 'local');
      assert.ok(r.session && r.session.state === 'active' && r.session.id !== pending.id, 'a new active id');
      assert.strictEqual(await p.sessions.restore(pending.id), null, 'the pending id is dead');
      const stored = await p.sessions.restore(r.session.id);
      assert.strictEqual(stored?.facts.assurance, 'aal2');
      assert.ok(r.facts.sessionHandle && r.facts.sessionHandle === stored.facts.sessionHandle);
      assert.ok(!('authenticatedAt' in r.facts));
      assert.deepStrictEqual(
        p.events.all().map((e) => `${e.type}:${e.outcome}`),
        ['mfa.verify:success', 'login:success'],
      );
      assert.ok(p.events.all().every((e) => e.session === r.facts.sessionHandle && e.identity?.id === a.id && e.strategy === 'local'));
    });

    it('counts the mfa flow with the identity keys before verifying, and gives them back on success (D14)', async () => {
      const p = await boot(undefined);
      const { a, pending } = await pendingAlice(p);
      success(await p.service.completeMfa(pending, p.step.name, p.step.nextCode(a), ctx()));
      assert.deepStrictEqual(flowCalls(throttle!.attempts, 'mfa'), [identityKeys(a, IP)]);
      assert.deepStrictEqual(flowCalls(throttle!.succeeds, 'mfa'), [identityKeys(a, IP)]);
    });

    it('builds the mfa keys without an ip as `<id>|` and no ip key (D14)', async () => {
      const p = await boot(undefined);
      const { a, pending } = await pendingAlice(p);
      failure(await p.service.completeMfa(pending, p.step.name, 'wrong', ctx({ ip: undefined })), 'invalid_credentials');
      assert.deepStrictEqual(flowCalls(throttle!.attempts, 'mfa'), [identityKeys(a, undefined)]);
    });

    it('refuses once the mfa account key is spent, verifying nothing, and audits throttle.block', async () => {
      const p = await boot(undefined);
      const { a, pending } = await pendingAlice(p);
      for (let i = 0; i < 3; i++) failure(await p.service.completeMfa(pending, p.step.name, 'wrong', ctx({ now: NOW })), 'invalid_credentials');
      const calls = p.step.verifyCalls.length;
      const r = failure(await p.service.completeMfa(pending, p.step.name, p.step.nextCode(a), ctx({ now: NOW })), 'throttled');
      assert.strictEqual(r.retryAfterSeconds, 1);
      assert.strictEqual(p.step.verifyCalls.length, calls, 'nothing verified');
      const blocks = p.events.all().filter((e) => e.type === 'throttle.block');
      assert.strictEqual(blocks.length, 1);
      assert.deepStrictEqual(blocks[0].identity, a);
      assert.strictEqual((await p.sessions.restore(pending.id))?.handle.state, 'pending');
      success(await p.service.completeMfa(pending, p.step.name, p.step.nextCode(a), ctx({ now: new Date(NOW.getTime() + 1000) })));
    });

    it('fails a wrong code, keeps the session pending, and audits mfa.verify without the code', async () => {
      const p = await boot(undefined);
      const { pending } = await pendingAlice(p);
      failure(await p.service.completeMfa(pending, p.step.name, 'wrong-code-123', ctx()), 'invalid_credentials');
      assert.strictEqual((await p.sessions.restore(pending.id))?.handle.state, 'pending');
      const verify = p.events.all().filter((e) => e.type === 'mfa.verify');
      assert.deepStrictEqual(
        verify.map((e) => `${e.outcome}:${e.reason}`),
        ['failure:invalid_code'],
      );
      const json = JSON.stringify(p.events.all());
      for (const secret of ['wrong-code-123', pending.id]) assert.ok(!json.includes(secret), secret);
      assert.strictEqual(throttle!.succeeds.filter((x) => x.flow === 'mfa').length, 0);
    });

    it('refuses a step the pending session does not require, verifying nothing', async () => {
      const second = new StubStep('second', { enrolled: false, accepts: 'x' });
      const p = await boot(undefined, withSteps([second]));
      const { pending } = await pendingAlice(p);
      failure(await p.service.completeMfa(pending, 'second', 'x', ctx()), 'invalid_credentials');
      failure(await p.service.completeMfa(pending, 'kit-no-step', 'x', ctx()), 'invalid_credentials');
      assert.deepStrictEqual(second.verifyCalls, []);
      assert.deepStrictEqual(
        p.events
          .all()
          .filter((e) => e.type === 'mfa.verify')
          .map((e) => e.reason),
        ['unknown_step', 'unknown_step'],
      );
      assert.strictEqual((await p.sessions.restore(pending.id))?.handle.state, 'pending');
    });

    it('refuses an expired pending session without counting', async () => {
      const clock = new FakeClock();
      clock.install();
      try {
        const p = await boot(undefined, {}, { authn: { session: { pendingTtlSeconds: 300 } } });
        const { a, pending } = await pendingAlice(p);
        clock.tick(301_000);
        failure(await p.service.completeMfa(pending, p.step.name, p.step.nextCode(a), ctx({ now: clock.now() })), 'invalid_credentials');
        assert.deepStrictEqual(flowCalls(throttle!.attempts, 'mfa'), []);
        assert.strictEqual(p.step.verifyCalls.length, 0);
      } finally {
        clock.uninstall();
      }
    });

    it('under force refuses the forced step for an identity not enrolled in it, without verifying', async () => {
      const forced = new StubStep('forced', { enrolled: false, accepts: 'x' });
      const p = await boot(undefined, withSteps([forced], 'kit-last'), { authn: { mfa: { policy: { force: true } } } });
      await seedAlice(p);
      const r = await p.service.authenticate(pw(ALICE.login, ALICE.password), ctx());
      assert.deepStrictEqual([...(r as Pending).steps], ['forced']);
      failure(await p.service.completeMfa((r as Pending).pending, 'forced', 'x', ctx()), 'invalid_credentials');
      assert.deepStrictEqual(forced.verifyCalls, []);
      assert.ok(p.events.all().some((e) => e.type === 'mfa.verify' && e.reason === 'not_enrolled'));
      assert.strictEqual(flowCalls(throttle!.attempts, 'mfa').length, 1, 'still counted');
    });

    it('refuses an active or an unknown session without counting', async () => {
      const p = await boot(undefined);
      const a = await seedAlice(p);
      const r = success(await p.service.authenticate(pw(ALICE.login, ALICE.password), ctx()));
      p.step.enrol(a);
      failure(await p.service.completeMfa(r.session!, p.step.name, p.step.nextCode(a), ctx()), 'invalid_credentials');
      failure(await p.service.completeMfa({ id: 'no-such-session', state: 'pending' }, p.step.name, '000000', ctx()), 'invalid_credentials');
      assert.strictEqual((await p.sessions.restore(r.session!.id))?.facts.assurance, 'aal1', 'the active session is unchanged');
      assert.deepStrictEqual(flowCalls(throttle!.attempts, 'mfa'), []);
      assert.strictEqual(p.step.verifyCalls.length, 0);
    });

    it('completes with a recovery code through the first enrolled step that takes them (D6)', async () => {
      const early = new StubStep('early', { enrolled: false, recovery: 'stub-recovery' });
      const plain = new StubStep('plain', { enrolled: true });
      const p = await boot(undefined, withSteps([early, plain], 'kit-last'));
      const { a, pending } = await pendingAlice(p);
      const [c1] = await p.step.regenerateRecoveryCodes!(a);
      failure(await p.service.completeMfa(pending, 'recovery', 'stub-recovery', ctx()), 'invalid_credentials');
      failure(await p.service.completeMfa(pending, 'recovery', p.step.nextCode(a), ctx()), 'invalid_credentials');
      const r = success(await p.service.completeMfa(pending, 'recovery', c1, ctx()));
      assert.strictEqual(r.facts.assurance, 'aal2');
      assert.deepStrictEqual([...r.facts.mfa], ['recovery']);
      assert.strictEqual(flowCalls(throttle!.attempts, 'mfa').length, 3, 'recovery codes count in the mfa flow');
      const again = await p.service.authenticate(pw(ALICE.login, ALICE.password), ctx());
      assert.strictEqual(again.status, 'mfa_required');
      failure(await p.service.completeMfa((again as Pending).pending, 'recovery', c1, ctx()), 'invalid_credentials');
    });

    it('refuses an identity banned between the two steps and ends its pending session', async () => {
      const p = await boot(undefined);
      const { a, pending } = await pendingAlice(p);
      p.identities.setStatus(a, { banned: true });
      failure(await p.service.completeMfa(pending, p.step.name, p.step.nextCode(a), ctx()), 'invalid_credentials');
      assert.ok(p.events.all().some((e) => e.outcome === 'failure' && e.reason === 'banned'));
      assert.ok(!p.events.all().some((e) => e.outcome === 'success' && (e.type === 'login' || e.type === 'mfa.verify')));
      assert.strictEqual(await p.sessions.restore(pending.id), null);
      assert.strictEqual(throttle!.succeeds.filter((x) => x.flow === 'mfa').length, 0);
    });

    it('refuses a pending session for which the policy now requires no step (D15)', async () => {
      const p = await boot(undefined);
      const a = await seedAlice(p);
      const facts: AuthnFacts = { method: 'password', strategy: 'local', assurance: 'aal1', mfa: [], authenticatedAt: new Date() };
      const pending = await p.sessions.issue(a, facts, { pending: { steps: [] } });
      failure(await p.service.completeMfa(pending, p.step.name, '000000', ctx()), 'invalid_credentials');
      assert.strictEqual(p.step.verifyCalls.length, 0);
      assert.ok(p.events.all().some((e) => e.type === 'mfa.verify' && e.reason === 'no_steps'));
    });
  });

  describe('reauthenticate', () => {
    const NOW = new Date('2026-10-03T10:00:00Z');

    async function signedIn(p: CoreParts): Promise<{ a: IdentityRef; session: SessionHandle }> {
      const a = await seedAlice(p);
      const r = success(await p.service.authenticate(pw(ALICE.login, ALICE.password), ctx()));
      return { a, session: r.session! };
    }

    const again = (p: CoreParts, session: SessionHandle, c: Credentials, over: Partial<AuthnContext> = {}) => p.service.reauthenticate(session, c, ctx({ purpose: 'reauth', session, ...over }));

    it('answers true for the session identity, counts the reauth flow and changes no session (D14)', async () => {
      const p = await boot(undefined);
      const { a, session } = await signedIn(p);
      const before = await p.sessions.restore(session.id);
      p.events.clear();
      assert.strictEqual(await again(p, session, pw(ALICE.login, ALICE.password)), true);
      assert.deepStrictEqual(flowCalls(throttle!.attempts, 'reauth'), [identityKeys(a, IP)]);
      assert.deepStrictEqual(flowCalls(throttle!.succeeds, 'reauth'), [identityKeys(a, IP)]);
      assert.deepStrictEqual((await p.sessions.restore(session.id))?.facts, before!.facts);
      assert.deepStrictEqual(
        p.events.all().map((e) => `${e.type}:${e.outcome}:${e.identity?.id}`),
        [`reauth:success:${a.id}`],
      );
      assert.ok(!JSON.stringify(p.events.all()).includes(ALICE.password));
    });

    it("answers false for another identity's correct password", async () => {
      const p = await boot(undefined);
      const { session } = await signedIn(p);
      const bob = p.identities.add({ login: 'bob@example.test' });
      await p.passwords.set(bob, fakeHash('Bob-Pass-2345x'));
      assert.strictEqual(await again(p, session, pw('bob@example.test', 'Bob-Pass-2345x')), false);
      assert.ok(p.events.all().some((e) => e.type === 'reauth' && e.outcome === 'failure' && e.reason === 'other_identity'));
      assert.deepStrictEqual(flowCalls(throttle!.succeeds, 'reauth'), []);
    });

    it('answers false once the reauth account key is spent, verifying nothing, and audits throttle.block', async () => {
      const p = await boot(undefined);
      const { session } = await signedIn(p);
      const local = p.strategies[0].instance as FakeStrategy;
      for (let i = 0; i < 3; i++) assert.strictEqual(await again(p, session, pw(ALICE.login, WRONG), { now: NOW }), false);
      const calls = local.verifyCalls.length;
      assert.strictEqual(await again(p, session, pw(ALICE.login, ALICE.password), { now: NOW }), false);
      assert.strictEqual(local.verifyCalls.length, calls, 'nothing verified');
      assert.strictEqual(p.events.all().filter((e) => e.type === 'throttle.block').length, 1);
      assert.strictEqual(await again(p, session, pw(ALICE.login, ALICE.password), { now: new Date(NOW.getTime() + 1000) }), true);
    });

    it('answers false for a pending, a revoked or an unknown session without counting', async () => {
      const p = await boot(undefined);
      const a = await seedAlice(p);
      p.step.enrol(a);
      const r = await p.service.authenticate(pw(ALICE.login, ALICE.password), ctx());
      const pending = (r as Pending).pending;
      assert.strictEqual(await again(p, pending, pw(ALICE.login, ALICE.password)), false);
      assert.strictEqual(await again(p, { id: 'no-such-session', state: 'active' }, pw(ALICE.login, ALICE.password)), false);
      assert.deepStrictEqual(flowCalls(throttle!.attempts, 'reauth'), []);
    });

    it("answers false on an impersonation session, even for the target's own password, without counting (M6)", async () => {
      const p = await boot(undefined);
      const a = await seedAlice(p);
      const admin = p.identities.add({ login: 'admin@example.test' });
      const session = await p.sessions.issue(a, { method: 'password', strategy: 'local', assurance: 'aal2', mfa: ['fake'], authenticatedAt: new Date(), impersonator: admin });
      const local = p.strategies[0].instance as FakeStrategy;
      assert.strictEqual(await again(p, session, pw(ALICE.login, ALICE.password)), false);
      assert.deepStrictEqual(flowCalls(throttle!.attempts, 'reauth'), []);
      assert.strictEqual(local.verifyCalls.length, 0);
      assert.ok(p.events.all().some((e) => e.type === 'reauth' && e.outcome === 'failure' && e.reason === 'impersonation' && e.identity?.id === a.id));
    });

    it('answers false when the identity status now refuses', async () => {
      const p = await boot(undefined);
      const { a, session } = await signedIn(p);
      p.identities.setStatus(a, { banned: true });
      assert.strictEqual(await again(p, session, pw(ALICE.login, ALICE.password)), false);
      assert.ok(p.events.all().some((e) => e.type === 'reauth' && e.reason === 'banned'));
      assert.deepStrictEqual(flowCalls(throttle!.succeeds, 'reauth'), []);
    });

    it('takes no per-request credential as a re-authentication', async () => {
      const p = await boot(undefined);
      const { a, session } = await signedIn(p);
      p.tokens.set('kit-token', a);
      assert.strictEqual(await again(p, session, bearer('kit-token')), false);
      assert.strictEqual((p.strategies[1].instance as FakeStrategy).verifyCalls.length, 0);
    });

    it('binds a delegation or an external outcome to the session identity only through its own link', async () => {
      let alice: IdentityRef | undefined;
      const outcomes: Record<string, StrategyOutcome> = {
        linked: { ok: true, external: { provider: 'kit-idp', subject: 'sub-alice' }, method: 'oidc' },
        unlinked: { ok: true, external: { provider: 'kit-idp', subject: 'sub-none' }, method: 'oidc' },
        other: { ok: true, external: { provider: 'kit-idp', subject: 'sub-bob' }, method: 'oidc' },
      };
      const s = strategy('pwstub', {
        kinds: ['password'],
        interactive: true,
        verify: (c) => {
          const which = String((c as { password?: unknown }).password);
          if (which === 'delegation') return { ok: true, identity: alice!, method: 'password', delegation: { onBehalfOf: alice!, mode: 'inherit' } };
          return outcomes[which] ?? { ok: false, reason: 'invalid_credentials' };
        },
      });
      const p = await boot([s]);
      alice = await seedAlice(p);
      const bob = p.identities.add({ login: 'bob@example.test' });
      await p.links.link(alice, { provider: 'kit-idp', subject: 'sub-alice' });
      await p.links.link(bob, { provider: 'kit-idp', subject: 'sub-bob' });
      const session = await p.sessions.issue(alice, { method: 'password', strategy: 'pwstub', assurance: 'aal1', mfa: [], authenticatedAt: new Date() });
      assert.strictEqual(await again(p, session, pw(ALICE.login, 'linked')), true);
      for (const which of ['delegation', 'unlinked', 'other']) assert.strictEqual(await again(p, session, pw(ALICE.login, which)), false, which);
      assert.deepStrictEqual(
        p.events
          .all()
          .filter((e) => e.type === 'reauth')
          .map((e) => `${e.outcome}:${e.reason}`),
        ['success:undefined', 'failure:other_identity', 'failure:other_identity', 'failure:other_identity'],
      );
    });

    it('answers false when the strategy throws, auditing the error class only', async () => {
      const boom = strategy('local', {
        kinds: ['password'],
        interactive: true,
        verify: () => {
          throw new TypeError(`bad ${ALICE.password}`);
        },
      });
      const p = await boot([boom]);
      const a = await seedAlice(p);
      const session = await p.sessions.issue(a, { method: 'password', strategy: 'local', assurance: 'aal1', mfa: [], authenticatedAt: new Date() });
      assert.strictEqual(await again(p, session, pw(ALICE.login, ALICE.password)), false);
      const e = p.events.all().find((x) => x.type === 'reauth');
      assert.deepStrictEqual({ reason: e?.reason, data: e?.data }, { reason: 'strategy_error', data: { error: 'TypeError' } });
    });
  });

  describe('principalOf', () => {
    it('builds a per-request principal with authenticatedAt read at call time', async () => {
      const id: IdentityRef = { type: 'user', id: 'u-1' };
      const p = await boot([strategy('tok', { verify: () => ({ ok: true, identity: id, method: 'token', ceiling: { reason: 'c' }, attributes: { profile: 'p1' } }) })]);
      p.identities.add({ id: id.id, login: 'u' });
      const r = success(await p.service.authenticate(bearer('x'), ctx({ now: new Date(0), purpose: 'request' })));
      const before = Date.now();
      const principal = await p.service.principalOf(r);
      assert.ok(principal.authn!.authenticatedAt.getTime() >= before);
      const call = p.principals.calls.at(-1)!;
      assert.deepStrictEqual(call.extra, { ceiling: { reason: 'c' }, attributes: { profile: 'p1' } });
    });

    it('resolves the delegating identity to a principal through the same factory', async () => {
      const owner: IdentityRef = { type: 'user', id: 'owner-1' };
      const agent: IdentityRef = { type: 'agent', id: 'agent-1' };
      const p = await boot([strategy('agent', { verify: () => ({ ok: true, identity: agent, method: 'token', delegation: { onBehalfOf: owner, mode: 'inherit' } }) })]);
      p.identities.add({ id: owner.id, login: 'owner' });
      const principal = await p.service.principalOf(success(await p.service.authenticate(bearer('x'), ctx({ purpose: 'request' }))));
      assert.strictEqual(principal.type, 'agent');
      assert.strictEqual(principal.onBehalfOf?.id, owner.id);
      assert.strictEqual(principal.delegation, 'inherit');
      assert.deepStrictEqual(
        p.principals.calls.map((c) => c.id),
        [owner, agent],
      );
    });

    it('reads the facts from the session, and refuses a session that is gone', async () => {
      const p = await boot(undefined);
      await seedAlice(p);
      const now = new Date('2026-10-03T10:00:00Z');
      const r = success(await p.service.authenticate(pw(ALICE.login, ALICE.password), ctx({ now })));
      const principal = await p.service.principalOf(r);
      assert.strictEqual(principal.authn!.authenticatedAt.getTime(), now.getTime());
      assert.strictEqual(principal.authn!.sessionHandle, r.facts.sessionHandle);
      await p.sessions.revoke(r.session!);
      await assert.rejects(p.service.principalOf(r));
    });
  });

  describe('boot', () => {
    const failing = () => strategy('f', { verify: () => ({ ok: false, reason: 'invalid_credentials' }) });

    it('uses the throttle named by authn.throttle.service', async () => {
      const other = new MemoryAuthnThrottle(DEFAULT_THROTTLE_PARAMS);
      const p = await boot([failing()], { raw: { authn: { throttle: { service: 'OtherThrottle' } } }, register: (c) => bind(c, AuthnThrottle, 'OtherThrottle', other) });
      let called = 0;
      const attempt = other.attempt.bind(other);
      other.attempt = async (...a) => {
        called++;
        return attempt(...a);
      };
      await p.service.authenticate(bearer('x'), ctx());
      assert.strictEqual(called, 1);
      assert.strictEqual(throttle!.attempts.length, 0);
    });

    it('fails boot when authn.throttle.service names a throttle that is not registered', async () => {
      const message = await bootFails([failing()], { raw: { authn: { throttle: { service: 'DbAuthnThrottle' } } } }, 'authn.throttle.service', 'DbAuthnThrottle', 'MemoryAuthnThrottle');
      assert.ok(!message.includes('undefined'));
    });

    it('fails boot when authn.throttle.service is unset and more than one throttle is registered', async () => {
      await bootFails([failing()], { register: (c) => bind(c, AuthnThrottle, 'OtherThrottle', new RecordingThrottle(DEFAULT_THROTTLE_PARAMS)) }, 'authn.throttle.service', 'OtherThrottle');
    });

    it('fails boot when a required neighbour is not registered', async () => {
      await bootFails([failing()], { omit: ['IdentityStore'] }, 'IdentityStore');
      await bootFails([failing()], { omit: ['PrincipalFactory'] }, 'PrincipalFactory');
    });

    it('needs a SessionIssuer, the MfaPolicy and the MFA steps only when an interactive strategy is listed', async () => {
      const broken = { authn: { mfa: { policy: { service: 'NoSuchPolicy' }, steps: [{ name: 'gone', service: 'NoSuchStep' }] } } };
      await boot([failing()], { omit: ['SessionIssuer'], raw: broken });
      await parts!.dispose();
      parts = undefined;
      const interactive = strategy('i', { kinds: ['password'], interactive: true, verify: () => ({ ok: false, reason: 'invalid_credentials' }) });
      await bootFails([interactive], { omit: ['SessionIssuer'] }, 'SessionIssuer');
      await bootFails([interactive], { raw: { authn: { mfa: { policy: { service: 'NoSuchPolicy' } } } } }, 'authn.mfa.policy.service', 'NoSuchPolicy', 'DefaultMfaPolicy');
      await bootFails([interactive], { raw: { authn: { mfa: { steps: [{ name: 'gone', service: 'NoSuchStep' }] } } } }, 'authn.mfa.steps', 'NoSuchStep');
    });

    it('uses the MfaPolicy named by authn.mfa.policy.service', async () => {
      class Always extends MfaPolicy {
        async required(): Promise<readonly string[]> {
          return ['fake'];
        }
      }
      const p = await boot(undefined, { raw: { authn: { mfa: { policy: { service: 'AlwaysPolicy' } } } }, register: (c) => bind(c, MfaPolicy, 'AlwaysPolicy', new Always()) });
      await seedAlice(p);
      assert.strictEqual((await p.service.authenticate(pw(ALICE.login, ALICE.password), ctx())).status, 'mfa_required');
    });

    it('is one instance per container (D11)', async () => {
      const p = await boot([failing()]);
      const again = await p.child.resolve(DefaultAuthnService);
      assert.strictEqual(again, p.service);
      const other = await buildCore({}, { strategies: [spec(failing())] });
      try {
        assert.notStrictEqual(other.service, p.service);
      } finally {
        await other.dispose();
      }
    });
  });
});
