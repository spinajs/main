import assert from 'node:assert/strict';
import 'mocha';
import { FakeStrategy, fakeHash } from '@spinajs/authn-testing';
import type { Configuration } from '@spinajs/configuration';

import { AuthnThrottle, DEFAULT_THROTTLE_PARAMS, DefaultAuthnService, MemoryAuthnThrottle } from '../../src/index.js';
import type { AuthenticationResult, AuthnContext, AuthnEvent, Credentials, ExternalSubject, IdentityRef, StrategyOutcome, ThrottleFlow, ThrottleKey } from '../../src/index.js';
import { bind, buildCore, useHarnessLog } from '../behaviour/harness.js';
import type { CoreOptions, CoreParts, StrategySpec } from '../behaviour/harness.js';

const IP = '192.0.2.10';
const ALICE = { login: 'alice@example.test', password: 'Alice-Pass-1234' };
const WRONG = 'Wrong-Pass-9876';

class RecordingThrottle extends MemoryAuthnThrottle {
  readonly attempts: { keys: ThrottleKey[]; flow: ThrottleFlow }[] = [];
  readonly succeeds: { keys: ThrottleKey[]; flow: ThrottleFlow }[] = [];

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
    const id = p.identities.add({ login: ALICE.login, status });
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

    it('counts the attempt once, with the union of the candidates keys and the ip', async () => {
      const { p } = await bootBearers();
      await p.service.authenticate(bearer('h.good.s'), ctx({ purpose: 'request' }));
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

  describe('a success takes only its own account off the ip key (D8)', () => {
    const passwordLike = (name: string, accountOf: (login: string) => string, accountIpOf: ((account: string, ip: string) => string) | null, owns: boolean): FakeStrategy =>
      strategy(name, {
        kinds: ['password'],
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
      assert.ok(!throttle!.attempts[0].keys.some((k) => k.value === `victim0|${IP}`), 'no account-ip added next to the strategy own one');
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

    it('needs a SessionIssuer and an MfaPolicy only when an interactive strategy is listed', async () => {
      await boot([failing()], { omit: ['SessionIssuer', 'MfaPolicy'] });
      await parts!.dispose();
      parts = undefined;
      const interactive = strategy('i', { kinds: ['password'], interactive: true, verify: () => ({ ok: false, reason: 'invalid_credentials' }) });
      await bootFails([interactive], { omit: ['SessionIssuer'] }, 'SessionIssuer');
      await bootFails([interactive], { omit: ['MfaPolicy'] }, 'MfaPolicy');
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

    it('leaves completeMfa and reauthenticate to task 3', async () => {
      const p = await boot([failing()]);
      await assert.rejects(p.service.completeMfa({ id: 'x', state: 'pending' }, 'fake', '000000', ctx()), /not implemented/);
      await assert.rejects(p.service.reauthenticate({ id: 'x', state: 'active' }, bearer('x'), ctx()), /not implemented/);
    });
  });
});
