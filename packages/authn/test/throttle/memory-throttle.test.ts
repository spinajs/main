import assert from 'node:assert/strict';
import 'mocha';
import { DI } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { InvalidArgument, InvalidOperation, InvalidOption } from '@spinajs/exceptions';
import { ALICE, BOB, CAROL, DAVE, DEFAULT_THROTTLE, FakeClock, IP_A, IP_B, attackerIp, backoffSchedule, burst, expectAllowed, expectRefused, pwKeys, runThrottleConformance, throttleParams, walkBackoff } from '@spinajs/authn-testing';
import type { ThrottleParams as KitParams } from '@spinajs/authn-testing';

import { AuthnThrottle, DEFAULT_THROTTLE_MAX_ROWS, DEFAULT_THROTTLE_PARAMS, MemoryAuthnThrottle, backoffDelayMs } from '../../src/index.js';
import type { AuthnContext, ThrottleFlow, ThrottleKey, ThrottleParams } from '../../src/index.js';
import { configuredChild, configurationOf, pinConfiguration, violationPaths } from '../behaviour/harness.js';
import { Lockout } from '../mutation/throttle-mutants.js';
import { TestLog, useTestLog } from '../audit/test-log.js';

type Make = (p: ThrottleParams) => AuthnThrottle;

const real: Make = (p) => new MemoryAuthnThrottle(p);

const FLOWS: readonly ThrottleFlow[] = ['login', 'mfa', 'reset', 'reauth'];

/** Reads its rows: the stored ids and how many are held. */
class Probe extends MemoryAuthnThrottle {
  reported = 0;
  has(flow: ThrottleFlow, k: ThrottleKey): boolean {
    return this.tables[flow].rows.has(this.keyId(flow, k));
  }
  noSweep(): this {
    this.sweepBatch = 0;
    return this;
  }
  protected reportFull(): void {
    this.reported++;
  }
  private entries() {
    return FLOWS.flatMap((f) => [...this.tables[f].rows]);
  }
  ids(): string[] {
    return this.entries().map(([id]) => id);
  }
  dump(): string {
    return JSON.stringify(this.entries());
  }
  get rowCount(): number {
    return FLOWS.reduce((n, f) => n + this.tables[f].rows.size, 0);
  }
}

/** 2.x shape (SR-05): reads the rows, awaits, then writes from the stale read. */
class ReadModifyWrite extends MemoryAuthnThrottle {
  async attempt(keys: readonly ThrottleKey[], flow: ThrottleFlow, ctx: AuthnContext) {
    const read = FLOWS.map((f) => [f, new Map([...this.tables[f].rows].map(([k, r]) => [k, { ...r }]))] as const);
    await new Promise((r) => setImmediate(r));
    for (const [f, rows] of read) {
      this.tables[f].rows.clear();
      rows.forEach((r, k) => this.tables[f].rows.set(k, r));
    }
    return super.attempt(keys, flow, ctx);
  }
}

/** 2.x shape (SR-03): only the account is limited. */
class AccountOnly extends MemoryAuthnThrottle {
  constructor(p: ThrottleParams) {
    const strip = (f: ThrottleParams['login']) => ({ account: f.account });
    super({ ...p, login: strip(p.login), mfa: strip(p.mfa), reset: strip(p.reset), reauth: strip(p.reauth) });
  }
}

const tuned = (over: Parameters<typeof throttleParams>[0]): KitParams => throttleParams(over);

// The plan's SR tests, run on the real class and on the 2.x shaped mutants above.

async function sr03(make: Make, clock: FakeClock): Promise<void> {
  const t = make(DEFAULT_THROTTLE);
  const ipP = DEFAULT_THROTTLE.login.ip!;
  await walkBackoff({ throttle: t, flow: 'login', params: ipP, clock, attempts: ipP.free + 11, keysFor: (n) => pwKeys(`stuff${n}@example.test`, IP_A) });
  expectRefused(await t.attempt(pwKeys('fresh@example.test', IP_A), 'login', clock.ctx()), 300, 'one more account from the same IP waits the IP cap');
  expectAllowed(await t.attempt(pwKeys('stuff1@example.test', IP_B), 'login', clock.ctx()), 'the same accounts from another IP are not delayed');
}

async function sr05Burst(make: Make, clock: FakeClock): Promise<void> {
  const t = make(DEFAULT_THROTTLE);
  const acct = DEFAULT_THROTTLE.login.account!;
  const keys = pwKeys('burst@example.test', IP_A);
  const r = await burst(50, () => t.attempt(keys, 'login', clock.ctx()));
  assert.strictEqual(r.fulfilled().length, 50, 'no attempt rejects');
  assert.strictEqual(
    r.count((x) => x.allowed),
    acct.free,
    'one account: exactly the free attempts',
  );
  clock.tick(1000);
  const slot = await burst(20, () => t.attempt(keys, 'login', clock.ctx()));
  assert.strictEqual(
    slot.count((x) => x.allowed),
    1,
    'one backoff slot admits one attempt',
  );
  const ipP = DEFAULT_THROTTLE.login.ip!;
  const spread = await burst(60, (i) => t.attempt(pwKeys(`spread${i}@example.test`, IP_B), 'login', clock.ctx()));
  assert.strictEqual(
    spread.count((x) => x.allowed),
    ipP.free,
    'one IP: exactly the free attempts',
  );
}

async function sr05Owner(make: Make, clock: FakeClock): Promise<void> {
  const t = make(DEFAULT_THROTTLE);
  const acct = DEFAULT_THROTTLE.login.account!;
  for (let i = 0; i < 10_000; i++) {
    clock.tick(1000);
    await t.attempt(pwKeys(ALICE.login, attackerIp(i)), 'login', clock.ctx());
  }
  const r = await t.attempt(pwKeys(ALICE.login, IP_A), 'login', clock.ctx());
  assert.strictEqual(r.allowed, false, 'the attacker holds the account slot');
  const wait = (r as { retryAfterSeconds: number }).retryAfterSeconds;
  assert.ok(wait <= acct.maxDelayMs / 1000, `the owner waits ${wait} s`);
  clock.tick(wait * 1000);
  expectAllowed(await t.attempt(pwKeys(ALICE.login, IP_A), 'login', clock.ctx()), 'the owner after the wait');
}

describe('MemoryAuthnThrottle', function () {
  this.timeout(120_000);
  useTestLog();

  let clock: FakeClock;
  const ctx = (): AuthnContext => clock.ctx();

  beforeEach(() => {
    clock = new FakeClock(new Date('2026-10-01T12:00:00.000Z'));
    clock.install();
  });

  afterEach(() => clock.uninstall());

  describe('security regressions', () => {
    it('SR-03 credential stuffing from one IP backs off', () => sr03(real, clock));
    it('SR-05 parallel burst verifies only free attempts', () => sr05Burst(real, clock));
    it('SR-05 attacker cannot lock the owner out', () => sr05Owner(real, clock));

    it('the SR-03 test fails on a throttle that limits only the account', () =>
      assert.rejects(
        sr03((p) => new AccountOnly(p), clock),
        assert.AssertionError,
      ));
    it('the SR-05 burst test fails on a read-modify-write throttle', () =>
      assert.rejects(
        sr05Burst((p) => new ReadModifyWrite(p), clock),
        assert.AssertionError,
      ));
    it('the SR-05 owner test fails on a lockout', () =>
      assert.rejects(
        sr05Owner((p) => new Lockout(p), clock),
        assert.AssertionError,
      ));
  });

  describe('backoff', () => {
    it('computes the §22.5 login delays', () => {
      const acct = DEFAULT_THROTTLE_PARAMS.login.account!;
      const delays = Array.from({ length: 12 }, (_, i) => backoffDelayMs(acct, i + 1));
      assert.deepStrictEqual(delays, [0, 0, 0, 0, 1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000]);
      const ip = DEFAULT_THROTTLE_PARAMS.login.ip!;
      assert.deepStrictEqual(Array.from({ length: 30 }, (_, i) => backoffDelayMs(ip, i + 1)).slice(18), [0, 1000, 2000, 4000, 8000, 16000, 32000, 64000, 128000, 256000, 300000, 300000]);
      assert.deepStrictEqual(backoffSchedule(acct, 8), [0, 0, 0, 0, 0, 1000, 3000, 7000]);
    });

    it('the login account key follows the delay sequence', async () => {
      const acct = DEFAULT_THROTTLE.login.account!;
      await walkBackoff({ throttle: real(DEFAULT_THROTTLE), flow: 'login', params: acct, clock, attempts: acct.free + 9, keysFor: () => pwKeys('walk@example.test', IP_A) });
    });

    it('answers Retry-After rounded up, at least 1 s', async () => {
      const t = real(tuned({ authn: { throttle: { login: { account: { free: 1, baseDelayMs: 1500, maxDelayMs: 1500 } } } } }));
      const k = pwKeys('round@example.test', IP_A);
      expectAllowed(await t.attempt(k, 'login', ctx()));
      expectRefused(await t.attempt(k, 'login', ctx()), 2);
      clock.tick(1499);
      expectRefused(await t.attempt(k, 'login', ctx()), 1);
      clock.tick(1);
      expectAllowed(await t.attempt(k, 'login', ctx()));
    });

    it('refuses an early attempt and does not count it', async () => {
      const t = real(DEFAULT_THROTTLE);
      const k = pwKeys('early@example.test', IP_A);
      for (let i = 0; i < 5; i++) expectAllowed(await t.attempt(k, 'login', ctx()));
      for (let i = 0; i < 20; i++) expectRefused(await t.attempt(k, 'login', ctx()), 1, `early attempt ${i + 1}`);
      clock.tick(1000);
      expectAllowed(await t.attempt(k, 'login', ctx()), 'the slot after the first delay');
      expectRefused(await t.attempt(k, 'login', ctx()), 2, 'the sixth counted attempt waits 2 s, not more');
    });

    it('a refused attempt counts nothing, not even account-ip', async () => {
      const t = real(tuned({ authn: { throttle: { login: { account: { free: 2, baseDelayMs: 1000, maxDelayMs: 1000 }, ip: { free: 6, baseDelayMs: 1000, maxDelayMs: 300000 } } } } }));
      const at = (login: string) => t.attempt(pwKeys(login, IP_A), 'login', ctx());
      for (let i = 0; i < 2; i++) expectAllowed(await at(BOB.login), `bob ${i + 1}`);
      for (let i = 0; i < 2; i++) expectAllowed(await at(ALICE.login), `alice ${i + 1}`);
      for (let i = 0; i < 5; i++) expectRefused(await at(ALICE.login), 1, `alice refused ${i + 1}`);
      await t.succeed(pwKeys(ALICE.login, IP_A), 'login');
      for (let i = 0; i < 2; i++) expectAllowed(await at(CAROL.login), `carol ${i + 1}`);
      for (let i = 0; i < 2; i++) expectAllowed(await at(DAVE.login), `dave ${i + 1}`);
      expectRefused(await at('erin@example.test'), 1, 'the ip key holds bob, carol and dave');
    });

    it('lets the owner in within maxDelayMs from another IP after 10,000 failures by others', async () => {
      const t = real(DEFAULT_THROTTLE);
      for (let i = 0; i < 10_000; i++) {
        clock.tick(500);
        await t.attempt(pwKeys(ALICE.login, attackerIp(i)), 'login', ctx());
      }
      const r = await t.attempt(pwKeys(ALICE.login, IP_B), 'login', ctx());
      const wait = r.allowed ? 0 : r.retryAfterSeconds;
      assert.ok(wait <= 60, `waits ${wait} s`);
      clock.tick(wait * 1000);
      expectAllowed(await t.attempt(pwKeys(ALICE.login, IP_B), 'login', ctx()));
    });

    it('an account-ip key gates nothing', async () => {
      const t = real(DEFAULT_THROTTLE);
      for (let i = 0; i < 50; i++) expectAllowed(await t.attempt([{ kind: 'account-ip', value: `x|${IP_A}` }], 'login', ctx()));
    });

    it('a key listed twice in one attempt counts once', async () => {
      const t = real(DEFAULT_THROTTLE);
      const k: ThrottleKey[] = [
        { kind: 'account', value: 'twice@example.test' },
        { kind: 'account', value: 'twice@example.test' },
      ];
      for (let i = 0; i < 5; i++) expectAllowed(await t.attempt(k, 'login', ctx()), `attempt ${i + 1}`);
      expectRefused(await t.attempt(k, 'login', ctx()), 1);
    });

    it('ignores key kinds it has no params for and stores nothing for them', async () => {
      const t = new Probe(DEFAULT_THROTTLE);
      for (let i = 0; i < 50; i++) expectAllowed(await t.attempt([{ kind: 'device', value: 'd1' }], 'login', ctx()));
      assert.strictEqual(t.rowCount, 0);
    });

    it('gates the global key only when configured', async () => {
      const g: ThrottleKey = { kind: 'global', value: '*' };
      const off = real(DEFAULT_THROTTLE);
      for (let i = 0; i < 50; i++) expectAllowed(await off.attempt([g, { kind: 'account', value: `g${i}` }], 'login', ctx()));
      const on = real({ ...DEFAULT_THROTTLE, global: { free: 3, baseDelayMs: 2000, maxDelayMs: 2000 } });
      for (let i = 0; i < 3; i++) expectAllowed(await on.attempt([g, { kind: 'account', value: `g${i}` }], 'login', ctx()));
      expectRefused(await on.attempt([g, { kind: 'account', value: 'g9' }], 'login', ctx()), 2);
    });
  });

  describe('success', () => {
    it('resets the account key', async () => {
      const t = real(DEFAULT_THROTTLE);
      for (let i = 0; i < 4; i++) await t.attempt(pwKeys(ALICE.login, IP_A), 'login', ctx());
      await t.succeed(pwKeys(ALICE.login, IP_A), 'login');
      for (let i = 0; i < 5; i++) expectAllowed(await t.attempt(pwKeys(ALICE.login, IP_B), 'login', ctx()), `attempt ${i + 1}`);
      expectRefused(await t.attempt(pwKeys(ALICE.login, IP_B), 'login', ctx()), 1);
    });

    it("on an own account leaves other accounts' failures on the ip key", async () => {
      const t = real(tuned({ authn: { throttle: { login: { ip: { free: 6, baseDelayMs: 1000, maxDelayMs: 300000 } } } } }));
      const at = (login: string) => t.attempt(pwKeys(login, IP_A), 'login', ctx());
      for (let i = 0; i < 3; i++) expectAllowed(await at(BOB.login), `bob ${i + 1}`);
      for (let i = 0; i < 2; i++) expectAllowed(await at(ALICE.login), `alice ${i + 1}`);
      await t.succeed(pwKeys(ALICE.login, IP_A), 'login');
      for (let i = 0; i < 3; i++) expectAllowed(await at(CAROL.login), `carol ${i + 1}`);
      expectRefused(await at(DAVE.login), 1, 'the ip key still holds bob and carol');
    });

    it('takes the largest account-ip count off the ip key, not the sum, when an attempt carries several', async () => {
      const t = real(tuned({ authn: { throttle: { login: { ip: { free: 6, baseDelayMs: 1000, maxDelayMs: 300000 } } } } }));
      const aliceKeys: ThrottleKey[] = [...pwKeys(ALICE.login, IP_A), { kind: 'account-ip', value: `${IP_A}/${ALICE.login}` }];
      for (let i = 0; i < 3; i++) expectAllowed(await t.attempt(pwKeys(BOB.login, IP_A), 'login', ctx()), `bob ${i + 1}`);
      for (let i = 0; i < 2; i++) expectAllowed(await t.attempt(aliceKeys, 'login', ctx()), `alice ${i + 1}`);
      await t.succeed(aliceKeys, 'login');
      for (let i = 0; i < 3; i++) expectAllowed(await t.attempt(pwKeys(CAROL.login, IP_A), 'login', ctx()), `carol ${i + 1}`);
      expectRefused(await t.attempt(pwKeys(DAVE.login, IP_A), 'login', ctx()), 1, 'the ip key still holds bob and carol');
    });

    it('recomputes the ip delay from its last attempt', async () => {
      const t = real(tuned({ authn: { throttle: { login: { ip: { free: 2, baseDelayMs: 1000, maxDelayMs: 300000 } } } } }));
      const at = (login: string) => t.attempt(pwKeys(login, IP_A), 'login', ctx());
      expectAllowed(await at(BOB.login));
      expectAllowed(await at(BOB.login));
      clock.tick(1000);
      expectAllowed(await at(BOB.login));
      clock.tick(2000);
      expectAllowed(await at(ALICE.login), 'alice at +3 s, the fourth on the ip key');
      clock.tick(1000);
      await t.succeed(pwKeys(ALICE.login, IP_A), 'login');
      expectRefused(await at(CAROL.login), 1, 'three left: 2 s after the last attempt at +3 s');
      clock.tick(1000);
      expectAllowed(await at(CAROL.login));
      expectRefused(await at(DAVE.login), 4);
    });

    it('for reset clears nothing', async () => {
      const t = real(DEFAULT_THROTTLE);
      const k = pwKeys('reset@example.test', IP_A);
      expectAllowed(await t.attempt(k, 'reset', ctx()));
      expectRefused(await t.attempt(k, 'reset', ctx()), 60);
      await t.succeed(k, 'reset');
      expectRefused(await t.attempt(k, 'reset', ctx()), 60, 'after succeed');
    });
  });

  describe('idle decay', () => {
    it('a key idle for resetAfterSeconds starts from zero', async () => {
      const t = real(DEFAULT_THROTTLE);
      const acct = DEFAULT_THROTTLE.login.account!;
      const k = pwKeys('idle@example.test', IP_A);
      const last = await walkBackoff({ throttle: t, flow: 'login', params: acct, clock, attempts: acct.free + 4, keysFor: () => k });
      clock.set(new Date(last.getTime() + 86_400_000));
      for (let i = 0; i < acct.free; i++) expectAllowed(await t.attempt(k, 'login', ctx()), `attempt ${i + 1} after the idle time`);
      expectRefused(await t.attempt(k, 'login', ctx()), 1);
    });

    it('a key used just within resetAfterSeconds keeps its count', async () => {
      const t = real(DEFAULT_THROTTLE);
      const acct = DEFAULT_THROTTLE.login.account!;
      const k = pwKeys('busy@example.test', IP_A);
      const last = await walkBackoff({ throttle: t, flow: 'login', params: acct, clock, attempts: acct.free + 2, keysFor: () => k });
      clock.set(new Date(last.getTime() + 86_400_000 - 1));
      expectAllowed(await t.attempt(k, 'login', ctx()));
      expectRefused(await t.attempt(k, 'login', ctx()), 8);
    });

    it('a row whose delay outlasts resetAfterSeconds keeps delaying until it ends', async () => {
      const t = real({ ...tuned({ authn: { throttle: { login: { account: { free: 1, baseDelayMs: 600_000, maxDelayMs: 600_000 } } } } }), resetAfterSeconds: 1 });
      const k = pwKeys('long@example.test', IP_A);
      expectAllowed(await t.attempt(k, 'login', ctx()));
      clock.tick(2000);
      expectRefused(await t.attempt(k, 'login', ctx()), 598);
      clock.tick(598_000);
      expectAllowed(await t.attempt(k, 'login', ctx()));
    });
  });

  describe('flows', () => {
    for (const flow of ['login', 'mfa', 'reset', 'reauth'] as const) {
      it(`${flow} follows its own account parameters`, async () => {
        const p = DEFAULT_THROTTLE[flow].account!;
        await walkBackoff({ throttle: real(DEFAULT_THROTTLE), flow, params: p, clock, attempts: p.free + 4, keysFor: () => [{ kind: 'account', value: `flow-${flow}@example.test` }] });
      });
    }

    for (const flow of ['mfa', 'reset'] as const) {
      it(`${flow} follows its own ip parameters`, async () => {
        const p = DEFAULT_THROTTLE[flow].ip!;
        await walkBackoff({ throttle: real(DEFAULT_THROTTLE), flow, params: p, clock, attempts: p.free + 4, keysFor: (n) => pwKeys(`${flow}${n}@example.test`, IP_A) });
      });
    }

    it('reauth has no ip gate by default', async () => {
      const t = real(DEFAULT_THROTTLE);
      for (let i = 0; i < 100; i++) expectAllowed(await t.attempt(pwKeys(`re${i}@example.test`, IP_A), 'reauth', ctx()), `account ${i + 1}`);
    });

    it('flows count apart', async () => {
      const t = real(DEFAULT_THROTTLE);
      const k: ThrottleKey[] = [{ kind: 'account', value: 'apart@example.test' }];
      for (let i = 0; i < 5; i++) expectAllowed(await t.attempt(k, 'login', ctx()));
      expectRefused(await t.attempt(k, 'login', ctx()), 1);
      expectAllowed(await t.attempt(k, 'mfa', ctx()));
      expectAllowed(await t.attempt(k, 'reauth', ctx()));
    });

    it('rejects an unknown flow', async () => {
      await assert.rejects(real(DEFAULT_THROTTLE).attempt(pwKeys(ALICE.login, IP_A), 'signup' as ThrottleFlow, ctx()), InvalidArgument);
      await assert.rejects(real(DEFAULT_THROTTLE).succeed(pwKeys(ALICE.login, IP_A), 'signup' as ThrottleFlow), InvalidArgument);
    });

    it('rejects a key value that is not a string and a ctx without a valid now', async () => {
      const t = real(DEFAULT_THROTTLE);
      await assert.rejects(t.attempt([{ kind: 'account', value: 42 as unknown as string }], 'login', ctx()), InvalidArgument);
      await assert.rejects(t.attempt(pwKeys(ALICE.login, IP_A), 'login', { ...ctx(), now: new Date(NaN) }), InvalidArgument);
    });
  });

  describe('peek (K5)', () => {
    const SHORT = tuned({ authn: { throttle: { login: { account: { free: 1, baseDelayMs: 2000, maxDelayMs: 2000 } } } } });

    it('refuses while a delay holds and counts nothing', async () => {
      const t = new Probe(SHORT).noSweep();
      const keys = pwKeys(ALICE.login, IP_A);
      expectAllowed(await t.peek(keys, 'login', ctx()));
      assert.strictEqual(t.rowCount, 0, 'a peek stores nothing');
      expectAllowed(await t.attempt(keys, 'login', ctx()));
      const rows = t.dump();
      for (let i = 0; i < 5; i++) expectRefused(await t.peek(keys, 'login', ctx()), 2);
      expectAllowed(await t.peek(pwKeys(ALICE.login, IP_A), 'mfa', ctx()), 'flows peek apart');
      assert.strictEqual(t.dump(), rows, 'a peek changes no row');
      clock.tick(2000);
      expectAllowed(await t.peek(keys, 'login', ctx()));
      expectAllowed(await t.attempt(keys, 'login', ctx()), 'the peeks took no slot');
    });

    it('lets a fresh key through a full table, which only attempt refuses', async () => {
      const t = new Probe(tuned({ authn: { throttle: { login: { account: { free: 1, baseDelayMs: 600_000, maxDelayMs: 600_000 } } } } }), { maxRows: 4 }).noSweep();
      for (const v of ['a', 'b', 'c', 'd']) expectAllowed(await t.attempt([{ kind: 'account', value: v }], 'login', ctx()));
      const fresh: ThrottleKey[] = [{ kind: 'account', value: 'e' }];
      expectAllowed(await t.peek(fresh, 'login', ctx()));
      assert.strictEqual((await t.attempt(fresh, 'login', ctx())).allowed, false);
      expectRefused(await t.peek([{ kind: 'account', value: 'a' }], 'login', ctx()), 600);
    });

    it('rejects an unknown flow and a ctx without a valid now', async () => {
      const t = new MemoryAuthnThrottle(DEFAULT_THROTTLE);
      await assert.rejects(t.peek([], 'nope' as ThrottleFlow, ctx()), InvalidArgument);
      await assert.rejects(t.peek([], 'login', { ...ctx(), now: new Date(NaN) }), InvalidArgument);
    });
  });

  describe('storage', () => {
    it('keeps only keyed hashes of key values (D7)', async () => {
      const a = new Probe(DEFAULT_THROTTLE);
      const b = new Probe(DEFAULT_THROTTLE);
      await a.attempt(pwKeys(ALICE.login, IP_A), 'login', ctx());
      await b.attempt(pwKeys(ALICE.login, IP_A), 'login', ctx());
      assert.strictEqual(a.ids().length, 3);
      for (const raw of [ALICE.login, IP_A, 'alice', '192.0.2']) {
        assert.ok(!a.dump().includes(raw), `no ${raw} in the rows`);
      }
      for (const id of a.ids()) assert.match(id, /^[A-Za-z0-9_-]{43}$/);
      assert.deepStrictEqual(
        a.ids().filter((id) => b.ids().includes(id)),
        [],
        'each instance has its own secret',
      );
    });

    it('sweeps idle rows and keeps memory bounded', async () => {
      const t = new Probe(DEFAULT_THROTTLE);
      for (let i = 0; i < 1000; i++) await t.attempt(pwKeys(`sweep${i}@example.test`, attackerIp(i)), 'login', ctx());
      assert.strictEqual(t.rowCount, 3000);
      clock.tick(86_400_000);
      for (let i = 0; i < 10_000; i++) await t.attempt([{ kind: 'account-ip', value: `keep|${IP_A}` }], 'login', ctx());
      assert.ok(t.rowCount <= 1, `rows left: ${t.rowCount}`);
    });

    it('stays bounded across resetAfterSeconds windows under fresh keys only', async () => {
      const t = new Probe({ ...DEFAULT_THROTTLE, resetAfterSeconds: 60 });
      const perWindow = 2000;
      let most = 0;
      for (let i = 0; i < 10 * perWindow; i++) {
        clock.tick(60_000 / perWindow);
        expectAllowed(await t.attempt(pwKeys(`fresh${i}@example.test`, attackerIp(i)), 'login', ctx()));
        most = Math.max(most, t.rowCount);
      }
      assert.ok(most <= 4 * 3 * perWindow, `at most ${most} rows for ${3 * perWindow} live ones`);
    });

    it('never sweeps a row that still delays someone', async () => {
      const t = new Probe({ ...tuned({ authn: { throttle: { login: { account: { free: 1, baseDelayMs: 600_000, maxDelayMs: 600_000 } } } } }), resetAfterSeconds: 1 });
      const k = pwKeys('held@example.test', IP_A);
      expectAllowed(await t.attempt(k, 'login', ctx()));
      clock.tick(2000);
      for (let i = 0; i < 10_000; i++) await t.attempt([{ kind: 'account-ip', value: `other|${IP_B}` }], 'login', ctx());
      expectRefused(await t.attempt(k, 'login', ctx()), 598);
    });
  });

  describe('capacity', () => {
    const acct = (value: string): ThrottleKey[] => [{ kind: 'account', value }];
    const ip = (value: string): ThrottleKey[] => [{ kind: 'ip', value }];
    const LONG = tuned({ authn: { throttle: { login: { account: { free: 1, baseDelayMs: 600_000, maxDelayMs: 600_000 } } } } });

    it('drops expired rows when full, oldest first', async () => {
      const t = new Probe({ ...DEFAULT_THROTTLE, resetAfterSeconds: 60 }, { maxRows: 9 }).noSweep();
      const users = [ALICE, BOB, CAROL].map((u, i) => pwKeys(u.login, `198.51.100.${i}`));
      for (const k of users) expectAllowed(await t.attempt(k, 'login', ctx()));
      assert.strictEqual(t.rowCount, 9);
      clock.tick(61_000);
      expectAllowed(await t.attempt(pwKeys(DAVE.login, IP_B), 'login', ctx()));
      assert.strictEqual(t.rowCount, 9);
      for (const k of users[0]) assert.strictEqual(t.has('login', k), false, `alice's ${k.kind} row went`);
      assert.ok(t.has('login', { kind: 'account', value: DAVE.login }));
    });

    it('then evicts rows that delay nobody, oldest last attempt first', async () => {
      const t = new Probe(DEFAULT_THROTTLE, { maxRows: 9 }).noSweep();
      const keys = { a: pwKeys(ALICE.login, '198.51.100.1'), b: pwKeys(BOB.login, '198.51.100.2'), c: pwKeys(CAROL.login, '198.51.100.3') };
      for (const k of [keys.a, keys.b, keys.c, keys.a]) {
        expectAllowed(await t.attempt(k, 'login', ctx()));
        clock.tick(1000);
      }
      expectAllowed(await t.attempt(pwKeys(DAVE.login, '198.51.100.4'), 'login', ctx()));
      assert.strictEqual(t.rowCount, 9);
      for (const k of keys.b) assert.strictEqual(t.has('login', k), false, `bob's ${k.kind} row is evicted`);
      for (const k of [...keys.a, ...keys.c]) assert.ok(t.has('login', k), `${k.kind} row kept`);
    });

    it('never evicts a row that delays someone', async () => {
      const t = new Probe(LONG, { maxRows: 4 }).noSweep();
      expectAllowed(await t.attempt(acct('held'), 'login', ctx()));
      for (const v of ['b', 'c', 'd']) {
        clock.tick(1000);
        expectAllowed(await t.attempt(ip(v), 'login', ctx()));
      }
      clock.tick(1000);
      expectAllowed(await t.attempt(ip('e'), 'login', ctx()));
      assert.strictEqual(t.has('login', ip('b')[0]), false, 'the oldest idle row went');
      expectRefused(await t.attempt(acct('held'), 'login', ctx()), 596);
    });

    it('refuses when every row delays someone, counts nothing and logs once', async () => {
      const t = new Probe(LONG, { maxRows: 4 }).noSweep();
      for (const v of ['a1', 'a2', 'a3', 'a4']) expectAllowed(await t.attempt(acct(v), 'login', ctx()));
      clock.tick(1000);
      expectRefused(await t.attempt(acct('a5'), 'login', ctx()), 599);
      clock.tick(1000);
      expectRefused(await t.attempt(acct('a6'), 'login', ctx()), 598);
      assert.strictEqual(t.has('login', acct('a5')[0]), false, 'a refusal counts nothing');
      assert.strictEqual(t.rowCount, 4);
      assert.strictEqual(t.reported, 1);
      clock.tick(598_000);
      expectAllowed(await t.attempt(acct('a5'), 'login', ctx()), 'room once a delay ends');
    });

    it('makes room again after a success', async () => {
      const t = new Probe(LONG, { maxRows: 4 }).noSweep();
      for (const v of ['a1', 'a2', 'a3', 'a4']) expectAllowed(await t.attempt(acct(v), 'login', ctx()));
      expectRefused(await t.attempt(acct('a5'), 'login', ctx()), 600);
      await t.succeed(acct('a1'), 'login');
      expectAllowed(await t.attempt(acct('a5'), 'login', ctx()));
    });

    it('a login flood never evicts an mfa row', async () => {
      const t = new MemoryAuthnThrottle(DEFAULT_THROTTLE, { maxRows: 300 });
      const victim = pwKeys('victim@example.test', '203.0.113.9');
      let guesses = 0;
      while (guesses < 12) {
        const r = await t.attempt(victim, 'mfa', ctx());
        if (r.allowed) guesses++;
        else clock.tick(r.retryAfterSeconds * 1000);
      }
      expectRefused(await t.attempt(victim, 'mfa', ctx()), 300);
      clock.tick(300_000);
      for (let i = 0; i < 300; i++) expectAllowed(await t.attempt(pwKeys(`flood${i}@example.test`, attackerIp(i)), 'login', ctx()));
      expectAllowed(await t.attempt(victim, 'mfa', ctx()), 'the open slot');
      expectRefused(await t.attempt(victim, 'mfa', ctx()), 300, 'the mfa row kept its count');
    });

    it('evicts rows below free before a deep-backoff row of the same flow', async () => {
      const t = new MemoryAuthnThrottle(DEFAULT_THROTTLE, { maxRows: 30 });
      const acctP = DEFAULT_THROTTLE.login.account!;
      const last = await walkBackoff({ throttle: t, flow: 'login', params: acctP, clock, attempts: 6, keysFor: () => acct('victim') });
      clock.set(new Date(last.getTime() + 2000));
      for (let i = 0; i < 100; i++) expectAllowed(await t.attempt(pwKeys(`flood${i}@example.test`, attackerIp(i)), 'login', ctx()));
      expectAllowed(await t.attempt(acct('victim'), 'login', ctx()), 'the open slot');
      expectRefused(await t.attempt(acct('victim'), 'login', ctx()), 4, 'the seventh counted attempt waits 4 s');
    });

    it('holds off a rescan when eviction frees less than the slack', async () => {
      const t = new MemoryAuthnThrottle(LONG, { maxRows: 1000 });
      for (let i = 0; i < 995; i++) expectAllowed(await t.attempt(acct(`held${i}`), 'login', ctx()));
      for (let i = 0; i < 5; i++) expectAllowed(await t.attempt(ip(`idle${i}`), 'login', ctx()));
      for (let i = 0; i < 5; i++) expectAllowed(await t.attempt(acct(`new${i}`), 'login', ctx()), `new ${i + 1}`);
      expectRefused(await t.attempt(acct('new5'), 'login', ctx()), 1, 'refused without a rescan');
      clock.tick(1000);
      expectRefused(await t.attempt(acct('new6'), 'login', ctx()), 599, 'after the hold-off every row still delays');
    });
  });

  describe('success without a clock', () => {
    it('does not take an account-ip run older than the ip key run off the ip key', async () => {
      const t = new Probe({ ...tuned({ authn: { throttle: { login: { ip: { free: 3, baseDelayMs: 1000, maxDelayMs: 1000 } } } } }), resetAfterSeconds: 60 }).noSweep();
      for (let i = 0; i < 2; i++) expectAllowed(await t.attempt(pwKeys(ALICE.login, IP_A), 'login', ctx()));
      clock.tick(61_000);
      for (let i = 0; i < 3; i++) expectAllowed(await t.attempt(pwKeys(BOB.login, IP_A), 'login', ctx()), `bob ${i + 1}`);
      await t.succeed(pwKeys(ALICE.login, IP_A), 'login');
      expectRefused(await t.attempt(pwKeys(CAROL.login, IP_A), 'login', ctx()), 1, 'the ip key still holds bob');
    });

    it('tells runs apart within one millisecond', async () => {
      const t = new Probe(tuned({ authn: { throttle: { login: { ip: { free: 3, baseDelayMs: 1000, maxDelayMs: 1000 } } } } }), { maxRows: 5 }).noSweep();
      expectAllowed(await t.attempt(pwKeys(ALICE.login, IP_A), 'login', ctx()));
      const crowd: ThrottleKey[] = ['e1', 'e2', 'e3', 'e4'].map((value) => ({ kind: 'account', value }));
      expectAllowed(await t.attempt(crowd, 'login', ctx()), 'evicts alice and the ip row, keeps her account-ip row');
      await t.succeed(crowd, 'login');
      for (let i = 0; i < 3; i++) expectAllowed(await t.attempt(pwKeys(BOB.login, IP_A), 'login', ctx()), `bob ${i + 1}`);
      await t.succeed(pwKeys(ALICE.login, IP_A), 'login');
      expectRefused(await t.attempt(pwKeys(CAROL.login, IP_A), 'login', ctx()), 1, 'the new ip row holds only bob');
    });
  });

  describe('configuration', () => {
    const kids: IContainer[] = [];

    afterEach(async () => {
      for (const c of kids.splice(0)) await c.dispose();
    });

    async function bootWith(throttle?: unknown): Promise<MemoryAuthnThrottle> {
      const child = await configuredChild({ authn: throttle === undefined ? {} : { throttle } });
      kids.push(child);
      return pinConfiguration(new MemoryAuthnThrottle(), child);
    }

    it('uses the schema defaults without authn.throttle', async () => {
      const t = await bootWith();
      assert.deepStrictEqual(t.params, DEFAULT_THROTTLE_PARAMS);
      assert.strictEqual(t.maxRows, DEFAULT_THROTTLE_MAX_ROWS);
    });

    it('merges authn.throttle over the defaults per flow and key', async () => {
      const over = { login: { account: { free: 2, baseDelayMs: 1000, maxDelayMs: 60000 } }, reauth: { ip: { free: 4, baseDelayMs: 500, maxDelayMs: 8000 } }, resetAfterSeconds: 600, global: { free: 100, baseDelayMs: 10, maxDelayMs: 1000 } };
      const t = await bootWith({ service: 'MemoryAuthnThrottle', ...over });
      assert.deepStrictEqual(t.params, throttleParams({ authn: { throttle: over } } as Parameters<typeof throttleParams>[0]));
      const k = pwKeys('cfg@example.test', IP_A);
      for (let i = 0; i < 2; i++) expectAllowed(await t.attempt(k, 'login', ctx()));
      expectRefused(await t.attempt(k, 'login', ctx()), 1);
    });

    it('reads maxRows from authn.throttle', async () => {
      assert.strictEqual((await bootWith({ maxRows: 5000 })).maxRows, 5000);
    });

    it('reads the configuration once, on first use: the tables assume fixed limits', async () => {
      const child = await configuredChild({ authn: { throttle: { maxRows: 5000 } } });
      kids.push(child);
      const t = pinConfiguration(new MemoryAuthnThrottle(), child);
      assert.strictEqual(t.maxRows, 5000);
      child.get(Configuration)!.set('authn.throttle.maxRows', 6000);
      assert.strictEqual(t.maxRows, 5000);
    });

    it('snapshots the limits: a later set neither changes them nor can a caller mutate the configuration', async () => {
      const child = await configuredChild({ authn: { throttle: {} } });
      kids.push(child);
      const t = pinConfiguration(new MemoryAuthnThrottle(), child);
      const free = t.params.login.account!.free;
      child.get(Configuration)!.set('authn.throttle.login.account.free', 0);
      assert.strictEqual(t.params.login.account!.free, free);
      assert.ok(Object.isFrozen(t.params.login.account));
      assert.ok(Object.isFrozen(t.params));
      assert.strictEqual(child.get(Configuration)!.get<number>('authn.throttle.login.account.free'), 0);
    });

    it('fails with InvalidOperation, not a TypeError, when authn.throttle is unset', async () => {
      const child = DI.RootContainer.child();
      kids.push(child);
      child.register(configurationOf({}, undefined, true)).as(Configuration);
      await child.resolve(Configuration);
      const t = pinConfiguration(new MemoryAuthnThrottle(), child);
      assert.throws(() => t.params, (e: Error) => e instanceof InvalidOperation && e.message.includes('authn.throttle is unset'));
    });

    it('takes explicit params without any Configuration', () => {
      const t = new MemoryAuthnThrottle(DEFAULT_THROTTLE);
      assert.strictEqual(t.params, DEFAULT_THROTTLE);
      assert.strictEqual(t.maxRows, DEFAULT_THROTTLE_MAX_ROWS);
    });

    it('refuses explicit params outside the schema ranges, in every flow, naming the key', () => {
      type Loose = Record<string, Record<string, Record<string, unknown> | undefined> | unknown>;
      const variant = (edit: (p: Loose) => void): ThrottleParams => {
        const p = structuredClone(DEFAULT_THROTTLE_PARAMS) as unknown as Loose;
        edit(p);
        return p as unknown as ThrottleParams;
      };
      const flowOf = (p: Loose, flow: string) => p[flow] as Record<string, Record<string, unknown> | undefined>;
      const cases: [string, ThrottleParams][] = [];
      for (const flow of FLOWS) {
        for (const [key, bad] of [['free', -1], ['free', Number.NaN], ['baseDelayMs', Infinity], ['maxDelayMs', 0], ['maxDelayMs', '60000']] as const) {
          cases.push([`${flow}.account.${key}`, variant((p) => (flowOf(p, flow).account![key] = bad))]);
        }
        cases.push([`${flow}.account`, variant((p) => delete flowOf(p, flow).account)]);
        cases.push([`${flow}.ip`, variant((p) => (flowOf(p, flow).ip = { free: 1, baseDelayMs: Number.NaN, maxDelayMs: 1 }))]);
        cases.push([flow, variant((p) => (p[flow] = null))]);
      }
      cases.push(['global', variant((p) => (p.global = { free: 0, baseDelayMs: 1000, maxDelayMs: 0 }))]);
      cases.push(['resetAfterSeconds', variant((p) => (p.resetAfterSeconds = 0))]);
      cases.push(['resetAfterSeconds', variant((p) => (p.resetAfterSeconds = Number.NaN))]);
      for (const [path, params] of cases) {
        assert.throws(() => new MemoryAuthnThrottle(params), (e: Error) => e instanceof InvalidOption && e.message.includes(`authn.throttle.${path}`), path);
      }
    });

    it('refuses an explicit maxRows that is not a positive integer', () => {
      for (const maxRows of [Number.NaN, Infinity, 0, 1.5, '10' as unknown as number]) {
        assert.throws(() => new MemoryAuthnThrottle(DEFAULT_THROTTLE, { maxRows }), (e: Error) => e instanceof InvalidOption && e.message.includes('maxRows'), String(maxRows));
      }
    });

    it('refuses limits set past the schema before the first use', async () => {
      for (const [path, bad] of [['authn.throttle.mfa.account.maxDelayMs', 0], ['authn.throttle.maxRows', Infinity]] as const) {
        const child = await configuredChild({ authn: { throttle: {} } });
        kids.push(child);
        child.get(Configuration)!.set(path, bad);
        const t = pinConfiguration(new MemoryAuthnThrottle(), child);
        await assert.rejects(t.attempt(pwKeys(ALICE.login, IP_A), 'mfa', ctx()), (e: Error) => e instanceof InvalidOption && e.message.includes(path.slice('authn.throttle.'.length)), path);
      }
    });

    const refused: [string, unknown, string][] = [
      ['a list', [], 'authn.throttle'],
      ['an unknown key', { logn: {} }, 'authn.throttle.logn'],
      ['an unknown key kind', { login: { acount: { free: 1, baseDelayMs: 1, maxDelayMs: 1 } } }, 'authn.throttle.login.acount'],
      ['an unknown backoff field', { login: { account: { free: 1, base: 1 } } }, 'authn.throttle.login.account.base'],
      ['a negative free', { login: { account: { free: -1, baseDelayMs: 1000, maxDelayMs: 60000 } } }, 'authn.throttle.login.account.free'],
      ['a fractional delay', { mfa: { ip: { free: 20, baseDelayMs: 1.5, maxDelayMs: 300000 } } }, 'authn.throttle.mfa.ip.baseDelayMs'],
      ['a zero maxDelayMs', { reset: { account: { free: 1, baseDelayMs: 60000, maxDelayMs: 0 } } }, 'authn.throttle.reset.account.maxDelayMs'],
      ['an incomplete new key', { reauth: { ip: { free: 1 } } }, 'authn.throttle.reauth.ip.baseDelayMs'],
      ['a zero resetAfterSeconds', { resetAfterSeconds: 0 }, 'authn.throttle.resetAfterSeconds'],
      ['a malformed global', { global: { free: 1 } }, 'authn.throttle.global.baseDelayMs'],
      ['a zero maxRows', { maxRows: 0 }, 'authn.throttle.maxRows'],
      ['a maxRows below 4', { maxRows: 3 }, 'authn.throttle.maxRows'],
      ['a maxRows above 16,000,000', { maxRows: 16_000_001 }, 'authn.throttle.maxRows'],
      ['a fractional maxRows', { maxRows: 1.5 }, 'authn.throttle.maxRows'],
      // The schema requires all three fields of a given backoff key.
      ['a partial backoff key', { login: { account: { free: 2 } } }, 'authn.throttle.login.account.baseDelayMs'],
      ['a partial ip key', { mfa: { ip: { free: 20, baseDelayMs: 1000 } } }, 'authn.throttle.mfa.ip.maxDelayMs'],
    ];
    for (const [what, bad, path] of refused) {
      it(`fails boot on ${what}, naming ${path}`, async () => {
        const paths = await violationPaths(configuredChild({ authn: { throttle: bad } }));
        assert.ok(paths.includes(path), paths.join(', '));
      });
    }
  });

  describe('DI', () => {
    class ThrottleTestConfiguration extends FrameworkConfiguration {
      protected onLoad(): unknown {
        return { authn: {} };
      }
    }

    let cfg: Configuration;

    before(async () => {
      DI.register(ThrottleTestConfiguration).as(Configuration);
      cfg = await DI.resolve(Configuration);
      assert.ok(cfg instanceof ThrottleTestConfiguration);
    });

    afterEach(() => DI.uncache(MemoryAuthnThrottle));

    after(() => {
      DI.uncache(ThrottleTestConfiguration);
      DI.unregister(ThrottleTestConfiguration);
    });

    it('resolves through DI as one instance registered as AuthnThrottle', async () => {
      cfg.set('authn.throttle', {});
      const t = await DI.resolve(MemoryAuthnThrottle);
      assert.strictEqual(await DI.resolve(MemoryAuthnThrottle), t);
      assert.ok((DI.getRegisteredTypes(AuthnThrottle) ?? []).includes(MemoryAuthnThrottle));
    });
  });
});

describe('MemoryAuthnThrottle kit', () => {
  runThrottleConformance((c) => {
    const params = throttleParams(c.config);
    return { throttle: { throttle: new MemoryAuthnThrottle(params), params } };
  });
});

describe('MemoryAuthnThrottle full table report', () => {
  useTestLog();

  class Reporting extends MemoryAuthnThrottle {
    report(flow: ThrottleFlow): void {
      this.reportFull(flow);
    }
  }

  it('warns on the Log named authn-throttle, naming no key', () => {
    new Reporting(DEFAULT_THROTTLE, { maxRows: 9 }).report('login');
    assert.deepStrictEqual(
      TestLog.entries.map((e) => [e.level, e.logger]),
      [['warn', 'authn-throttle']],
    );
    assert.match(TestLog.entries[0].message, /^MemoryAuthnThrottle: all 9 login rows delay someone/);
  });
});
