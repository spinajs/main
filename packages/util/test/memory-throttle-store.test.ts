import { expect } from 'chai';
import { InvalidArgument, InvalidOperation } from '@spinajs/exceptions';
import { KeyedBackoff, MemoryThrottleStore, Throttle } from '../src/index.js';
import type { BackoffParams, KeyedBackoffOptions, KeyedBackoffVerdict, MemoryThrottleStoreOptions, ThrottleGate, ThrottleKey } from '../src/index.js';

const ACCOUNT: BackoffParams = { free: 5, baseDelayMs: 1000, maxDelayMs: 60_000 };
const LONG: BackoffParams = { free: 1, baseDelayMs: 600_000, maxDelayMs: 600_000 };
const DAY = 86_400_000;
const FLOWS = ['login', 'mfa', 'reset'];

const gate = (id: string, backoff: BackoffParams = ACCOUNT): ThrottleGate => ({ id, backoff });

const make = (o: Partial<MemoryThrottleStoreOptions> = {}): MemoryThrottleStore => new MemoryThrottleStore({ flows: FLOWS, maxRows: 1000, resetAfterMs: DAY, ...o });

class Recording extends KeyedBackoff {
  readonly batches: (number | undefined)[] = [];
  constructor(
    readonly flow: string,
    readonly options: KeyedBackoffOptions,
  ) {
    super(options);
  }
  sweep(nowMs: number, batch?: number): void {
    this.batches.push(batch);
    super.sweep(nowMs, batch);
  }
}

function recording(o: Partial<MemoryThrottleStoreOptions> = {}) {
  const made = new Map<string, Recording>();
  const store = make({
    ...o,
    limiter: (flow, options) => {
      const l = new Recording(flow, options);
      made.set(flow, l);
      return l;
    },
  });
  return { store, made };
}

function expectAllowed(v: KeyedBackoffVerdict, why = ''): void {
  expect(v.allowed, `allowed ${why}`).to.equal(true);
}

function expectRefused(v: KeyedBackoffVerdict, seconds: number, why = ''): void {
  expect(v, `refused ${why}`).to.deep.equal({ allowed: false, retryAfterSeconds: seconds });
}

async function rejectsWith(p: Promise<unknown>, type: new (...args: never[]) => Error, message?: RegExp): Promise<void> {
  try {
    await p;
  } catch (e) {
    expect(e).to.be.instanceOf(type);
    if (message) expect((e as Error).message).to.match(message);
    return;
  }
  expect.fail('expected a rejection');
}

describe('MemoryThrottleStore', () => {
  describe('limiters', () => {

    it('passes the limits, the delay and a per-flow onFull to the factory', async () => {
      const full: string[] = [];
      const delay = (p: BackoffParams, n: number) => n * p.baseDelayMs;
      const { store, made } = recording({ maxRows: 50, resetAfterMs: 600_000, sweepBatch: 12, fullRetryMs: 7000, holdOffMs: 250, delay, onFull: (f) => full.push(f) });
      await store.attempt('login', [], [], 0);
      for (const f of FLOWS) {
        const { onFull, ...rest } = made.get(f)!.options;
        expect(rest).to.deep.equal({ maxRows: 50, resetAfterMs: 600_000, sweepBatch: 12, fullRetryMs: 7000, holdOffMs: 250, delay });
        onFull!();
      }
      expect(full).to.deep.equal(FLOWS);
    });

    it('fails closed, and keeps failing, when the factory returns something other than a KeyedBackoff', async () => {
      const store = make({ limiter: (flow, options) => (flow === 'mfa' ? ({} as KeyedBackoff) : new KeyedBackoff(options)) });
      await rejectsWith(store.attempt('login', [gate('a')], [], 0), InvalidOperation, /mfa.*not a KeyedBackoff/);
      await rejectsWith(store.attempt('login', [gate('a')], [], 0), InvalidOperation);
      await rejectsWith(store.peek('reset', [], 0), InvalidOperation);
      await rejectsWith(store.succeed('login', [], [], 0), InvalidOperation);
    });

    it('fails closed when the factory hands two flows one instance', async () => {
      class Shared extends KeyedBackoff {}
      const shared = new Shared({ maxRows: 10, resetAfterMs: DAY });
      const store = make({ limiter: () => shared });
      await rejectsWith(store.attempt('reset', [gate('a')], [], 0), InvalidOperation, /one Shared for the login and mfa flows/);
      await rejectsWith(store.attempt('reset', [gate('a')], [], 0), InvalidOperation);
      expect(shared.size).to.equal(0);
    });

    it('rejects a flow it was not given', async () => {
      const store = make();
      await rejectsWith(store.attempt('signup', [], [], 0), InvalidArgument);
      await rejectsWith(store.peek('toString', [], 0), InvalidArgument);
      await rejectsWith(store.succeed('signup', [], [], 0), InvalidArgument);
    });
  });

  describe('sweeping', () => {
    it("sweeps the attempt's flow with a full batch and every other flow with a quarter, rounded up", async () => {
      const { store, made } = recording({ sweepBatch: 10 });
      await store.attempt('login', [gate('a')], [], 0);
      // undefined: the limiter's own sweepBatch, inside KeyedBackoff.attempt.
      expect(made.get('login')!.batches).to.deep.equal([undefined]);
      expect(made.get('mfa')!.batches).to.deep.equal([3]);
      expect(made.get('reset')!.batches).to.deep.equal([3]);
    });
  });

  describe('succeed: lower', () => {
    const IP: BackoffParams = { free: 6, baseDelayMs: 1000, maxDelayMs: 300_000 };

    it('consumes the by rows and takes the largest count off the target, not the sum', async () => {
      const { store, made } = recording();
      for (let i = 0; i < 3; i++) await store.attempt('login', [gate('ip', IP)], ['bob'], 0);
      for (let i = 0; i < 2; i++) await store.attempt('login', [gate('ip', IP)], ['alice', 'alice2'], 0);
      await store.succeed('login', [{ targets: [gate('ip', IP)], by: ['alice', 'alice2', 'missing'] }], [], 0);
      const l = made.get('login')!;
      expect(l.row('ip')!.attempts).to.equal(3);
      expect(l.row('alice')).to.equal(undefined);
      expect(l.row('alice2')).to.equal(undefined);
      expect(l.row('bob')!.attempts).to.equal(3);
    });

    it('takes nothing off a target for a by row whose run began before it', async () => {
      const { store, made } = recording();
      for (let i = 0; i < 2; i++) await store.attempt('login', [], ['alice'], 0);
      for (let i = 0; i < 2; i++) await store.attempt('login', [gate('ip', IP)], [], 1000);
      await store.succeed('login', [{ targets: [gate('ip', IP)], by: ['alice'] }], [], 1000);
      const l = made.get('login')!;
      expect(l.row('ip')!.attempts).to.equal(2);
      expect(l.row('alice')).to.equal(undefined);
    });
  });

  describe('succeed: clear', () => {

    it('ends the hold-off of a nearly full table at once, even with no ids', async () => {
      const store = make({ maxRows: 200 });
      for (let i = 0; i < 199; i++) expectAllowed(await store.attempt('login', [gate(`held${i}`, LONG)], [], 0));
      expectAllowed(await store.attempt('login', [gate('idle')], [], 0));
      expectAllowed(await store.attempt('login', [gate('x')], [], 0), 'evicts idle, less than the slack');
      expectRefused(await store.attempt('login', [gate('y')], [], 0), 1, 'held off without a rescan');
      await store.succeed('login', [], [], 0);
      expectAllowed(await store.attempt('login', [gate('y')], [], 0), 'rescans and evicts x');
    });
  });

  describe('through Throttle (parity with MemoryAuthnThrottle)', () => {
    const IP: BackoffParams = { free: 6, baseDelayMs: 1000, maxDelayMs: 300_000 };
    const login = () =>
      new Throttle({
        store: make(),
        flows: {
          login: { gates: { account: ACCOUNT, ip: IP }, counted: ['account-ip'], onSuccess: { lower: [{ kind: 'ip', by: 'account-ip' }], clear: ['account', 'account-ip'] } },
          mfa: { gates: { account: ACCOUNT } },
          reset: { gates: { account: { free: 1, baseDelayMs: 60_000, maxDelayMs: 60_000 } } },
        },
      });
    const keys = (account: string, ip = '203.0.113.1'): ThrottleKey[] => [
      { kind: 'account', value: account },
      { kind: 'ip', value: ip },
      { kind: 'account-ip', value: `${ip}/${account}` },
    ];

    it("a success resets the account and leaves other accounts' failures on the ip key", async () => {
      const t = login();
      for (let i = 0; i < 3; i++) expectAllowed(await t.attempt(keys('bob'), 'login', 0), `bob ${i + 1}`);
      for (let i = 0; i < 2; i++) expectAllowed(await t.attempt(keys('alice'), 'login', 0), `alice ${i + 1}`);
      await t.succeed(keys('alice'), 'login', 0);
      for (let i = 0; i < 3; i++) expectAllowed(await t.attempt(keys('carol'), 'login', 0), `carol ${i + 1}`);
      expectRefused(await t.attempt(keys('dave'), 'login', 0), 1, 'the ip key still holds bob and carol');
      for (let i = 0; i < 5; i++) expectAllowed(await t.attempt(keys('alice', '198.51.100.7'), 'login', 1000), `alice reset ${i + 1}`);
    });

    it('a success of a flow without onSuccess clears nothing', async () => {
      const t = login();
      const k = keys('reset@example.test');
      expectAllowed(await t.attempt(k, 'reset', 0));
      expectRefused(await t.attempt(k, 'reset', 0), 60);
      await t.succeed(k, 'reset', 0);
      expectRefused(await t.attempt(k, 'reset', 0), 60, 'after succeed');
    });
  });
});
