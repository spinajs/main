import assert from 'node:assert/strict';
import 'mocha';
import { AuthnThrottle } from '@spinajs/authn/contracts';
import type { ThrottleKey } from '@spinajs/authn/contracts';
import { FakeClock } from '../../src/fakes/index.js';
import { DEFAULT_THROTTLE } from '../../src/harness/index.js';
import type { BackoffParams } from '../../src/harness/index.js';
import { backoffDelayMs, backoffSchedule, retryAfterSeconds, walkBackoff } from '../../src/helpers/index.js';
import { ReferenceBackoffThrottle } from '../reference/throttle.js';

const IP = '192.0.2.10';
const acct = DEFAULT_THROTTLE.login.account!;
const ipP = DEFAULT_THROTTLE.login.ip!;
const pwKeys = (l: string, ip: string): ThrottleKey[] => [
  { kind: 'account', value: l },
  { kind: 'account-ip', value: `${l}|${ip}` },
  { kind: 'ip', value: ip },
];

class OffByOne extends ReferenceBackoffThrottle {
  protected override delayMs(p: BackoffParams, n: number): number {
    return n < p.free ? 0 : Math.min(p.baseDelayMs * 2 ** (n - p.free + 1), p.maxDelayMs);
  }
}

class NoCap extends ReferenceBackoffThrottle {
  protected override delayMs(p: BackoffParams, n: number): number {
    return n < p.free ? 0 : p.baseDelayMs * 2 ** (n - p.free);
  }
}

class Locks extends ReferenceBackoffThrottle {
  protected override delayMs(p: BackoffParams, n: number): number {
    return n >= p.free + 3 ? 10 * 24 * 3600 * 1000 : super.delayMs(p, n);
  }
}

class CountsRefused extends ReferenceBackoffThrottle {
  protected override onRefused(row: { attempts: number; lastMs: number; nextMs: number }, p: BackoffParams, nowMs: number): void {
    row.attempts += 1;
    row.lastMs = nowMs;
    row.nextMs = nowMs + this.delayMs(p, row.attempts);
  }
}

class Open extends AuthnThrottle {
  async attempt(): Promise<{ allowed: true }> {
    return { allowed: true };
  }
  async succeed(): Promise<void> {}
}

describe('backoff helpers', () => {
  it('backoffSchedule gives the default login account schedule', () => {
    assert.deepEqual(backoffSchedule(acct, 13), [0, 0, 0, 0, 0, 1000, 3000, 7000, 15000, 31000, 63000, 123000, 183000]);
  });

  it('backoffDelayMs is zero before free and capped', () => {
    assert.equal(backoffDelayMs(acct, 4), 0);
    assert.equal(backoffDelayMs(acct, 5), 1000);
    assert.equal(backoffDelayMs(acct, 6), 2000);
    assert.equal(backoffDelayMs(acct, 40), 60000);
  });

  it('retryAfterSeconds rounds up', () => {
    assert.equal(retryAfterSeconds(1), 1);
    assert.equal(retryAfterSeconds(1000), 1);
    assert.equal(retryAfterSeconds(1001), 2);
  });

  describe('walkBackoff', () => {
    const t0 = new Date('2030-01-01T00:00:00Z');
    let clock: FakeClock;
    beforeEach(() => {
      clock = new FakeClock(t0);
    });

    const walk = (throttle: AuthnThrottle, attempts = acct.free + 8) => walkBackoff({ throttle, flow: 'login', params: acct, clock, attempts, keysFor: () => pwKeys('walk@example.test', IP) });

    it('passes on the reference throttle and returns the last attempt time', async () => {
      const last = await walk(new ReferenceBackoffThrottle(DEFAULT_THROTTLE));
      assert.equal(last.getTime(), t0.getTime() + backoffSchedule(acct, acct.free + 8).at(-1)!);
    });

    it('passes for distinct accounts behind one ip key', async () => {
      await walkBackoff({ throttle: new ReferenceBackoffThrottle(DEFAULT_THROTTLE), flow: 'login', params: ipP, clock, attempts: ipP.free + 11, keysFor: (n) => pwKeys(`stuff${n}@example.test`, IP) });
    });

    it('passes without probes', async () => {
      await walkBackoff({ throttle: new ReferenceBackoffThrottle(DEFAULT_THROTTLE), flow: 'login', params: acct, clock, attempts: 9, probeEarly: false, keysFor: () => pwKeys('walk@example.test', IP) });
    });

    it('fails on an off-by-one exponent', async () => {
      await assert.rejects(walk(new OffByOne(DEFAULT_THROTTLE)), assert.AssertionError);
    });

    it('fails on a missing cap', async () => {
      await assert.rejects(walk(new NoCap(DEFAULT_THROTTLE), acct.free + 12), assert.AssertionError);
    });

    it('fails on a throttle that locks', async () => {
      await assert.rejects(walk(new Locks(DEFAULT_THROTTLE)), assert.AssertionError);
    });

    it('fails on a throttle that counts refused attempts', async () => {
      await assert.rejects(walk(new CountsRefused(DEFAULT_THROTTLE)), assert.AssertionError);
    });

    it('fails on a throttle that never refuses', async () => {
      await assert.rejects(walk(new Open()), assert.AssertionError);
    });
  });
});

describe('reference backoff throttle', () => {
  it('lets exactly free attempts through at one instant, then refuses', async () => {
    const t = new ReferenceBackoffThrottle(DEFAULT_THROTTLE);
    const clock = new FakeClock();
    const out = await Promise.all(Array.from({ length: 50 }, () => t.attempt(pwKeys('burst@example.test', IP), 'login', clock.ctx())));
    assert.equal(out.filter((r) => r.allowed).length, acct.free);
    assert.deepEqual(out.find((r) => !r.allowed), { allowed: false, retryAfterSeconds: 1 });
  });

  it('a success clears only that account from the ip key', async () => {
    const t = new ReferenceBackoffThrottle({ ...DEFAULT_THROTTLE, login: { account: acct, ip: { free: 6, baseDelayMs: 1000, maxDelayMs: 300000 } } });
    const clock = new FakeClock();
    for (let i = 0; i < 3; i++) await t.attempt(pwKeys('bob@example.test', IP), 'login', clock.ctx());
    for (let i = 0; i < 2; i++) await t.attempt(pwKeys('alice@example.test', IP), 'login', clock.ctx());
    await t.succeed(pwKeys('alice@example.test', IP), 'login');
    for (let i = 0; i < 3; i++) assert.deepEqual(await t.attempt(pwKeys('carol@example.test', IP), 'login', clock.ctx()), { allowed: true });
    assert.deepEqual(await t.attempt(pwKeys('carol@example.test', IP), 'login', clock.ctx()), { allowed: false, retryAfterSeconds: 1 });
  });

  it('a reset success clears nothing', async () => {
    const t = new ReferenceBackoffThrottle(DEFAULT_THROTTLE);
    const clock = new FakeClock();
    const keys = [{ kind: 'account', value: 'reset@example.test' }];
    await t.attempt(keys, 'reset', clock.ctx());
    await t.succeed(keys, 'reset');
    assert.deepEqual(await t.attempt(keys, 'reset', clock.ctx()), { allowed: false, retryAfterSeconds: 60 });
  });

  it('a key idle for resetAfterSeconds starts from zero', async () => {
    const t = new ReferenceBackoffThrottle(DEFAULT_THROTTLE);
    const clock = new FakeClock();
    for (let i = 0; i < acct.free; i++) await t.attempt(pwKeys('idle@example.test', IP), 'login', clock.ctx());
    clock.tick(DEFAULT_THROTTLE.resetAfterSeconds * 1000 + 1000);
    for (let i = 0; i < acct.free; i++) assert.deepEqual(await t.attempt(pwKeys('idle@example.test', IP), 'login', clock.ctx()), { allowed: true });
  });
});
