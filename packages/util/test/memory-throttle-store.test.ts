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
    it('builds every flow through the factory on the first call of any, then reuses them', async () => {
      const calls: string[] = [];
      const store = make({
        limiter: (flow, options) => {
          calls.push(flow);
          return new KeyedBackoff(options);
        },
      });
      expect(calls).to.deep.equal([]);
      await store.peek('mfa', [], 0);
      expect(calls).to.deep.equal(FLOWS);
      for (const f of FLOWS) await store.attempt(f, [gate('a')], [], 0);
      await store.succeed('login', [{ targets: [], by: [] }], [], 0);
      await store.succeed('login', [], [], 0);
      expect(calls).to.deep.equal(FLOWS);
    });

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

    it('defaults to a KeyedBackoff per flow', async () => {
      const store = make();
      for (let i = 0; i < 5; i++) expectAllowed(await store.attempt('login', [gate('a')], [], 0));
      expectRefused(await store.attempt('login', [gate('a')], [], 0), 1);
      expectAllowed(await store.attempt('mfa', [gate('a')], [], 0), 'flows count apart');
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

    it('takes the quarter of the default batch of 8', async () => {
      const { store, made } = recording();
      await store.attempt('mfa', [], [], 0);
      expect(made.get('login')!.batches).to.deep.equal([2]);
    });

    it('sweeps nothing on peek or succeed', async () => {
      const { store, made } = recording();
      await store.peek('login', [gate('a')], 0);
      await store.succeed('login', [{ targets: [gate('a')], by: ['b'] }], ['a'], 0);
      for (const f of FLOWS) expect(made.get(f)!.batches).to.deep.equal([]);
    });
  });

  describe('attempt and peek', () => {
    it('lets only the free attempts of a parallel burst through', async () => {
      const store = make();
      const verdicts = await Promise.all(Array.from({ length: 20 }, () => store.attempt('login', [gate('a')], [], 0)));
      expect(verdicts.filter((v) => v.allowed)).to.have.length(5);
    });

    it('a refused attempt counts nothing, not even a counted id', async () => {
      const { store, made } = recording();
      for (let i = 0; i < 5; i++) await store.attempt('login', [gate('a')], [], 0);
      expectRefused(await store.attempt('login', [gate('a')], ['c'], 500), 1);
      expect(made.get('login')!.row('a')!.attempts).to.equal(5);
      expect(made.get('login')!.row('c')).to.equal(undefined);
    });

    it('peek refuses while a delay holds and counts nothing', async () => {
      const { store, made } = recording();
      for (let i = 0; i < 5; i++) await store.attempt('login', [gate('a')], [], 0);
      expectRefused(await store.peek('login', [gate('a')], 500), 1);
      expectAllowed(await store.peek('login', [gate('fresh')], 500));
      expect(made.get('login')!.row('a')!.attempts).to.equal(5);
      expect(made.get('login')!.size).to.equal(1);
    });

    it('peek lets a fresh key through a full table, which only attempt refuses', async () => {
      const store = make({ maxRows: 2 });
      for (const id of ['a1', 'a2']) expectAllowed(await store.attempt('login', [gate(id, LONG)], [], 0));
      expectRefused(await store.attempt('login', [gate('a3', LONG)], [], 0), 600);
      expectAllowed(await store.peek('login', [gate('a3', LONG)], 0));
    });

    it('a flood in one flow never evicts a row of another', async () => {
      const store = make({ maxRows: 10 });
      expectAllowed(await store.attempt('mfa', [gate('victim', LONG)], [], 0));
      for (let i = 0; i < 50; i++) expectAllowed(await store.attempt('login', [gate(`flood${i}`)], [], 0));
      expectRefused(await store.attempt('mfa', [gate('victim', LONG)], [], 0), 600);
    });

    it('reports a full table to onFull with its flow, once per episode', async () => {
      const full: string[] = [];
      const store = make({ maxRows: 1, onFull: (f) => full.push(f) });
      await store.attempt('mfa', [gate('a', LONG)], [], 0);
      for (let i = 0; i < 3; i++) await store.attempt('mfa', [gate(`b${i}`, LONG)], [], 0);
      expect(full).to.deep.equal(['mfa']);
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

    it('deletes a target lowered to 0', async () => {
      const { store, made } = recording();
      for (let i = 0; i < 2; i++) await store.attempt('login', [gate('ip', IP)], ['alice'], 0);
      await store.succeed('login', [{ targets: [gate('ip', IP)], by: ['alice'] }], [], 0);
      expect(made.get('login')!.size).to.equal(0);
    });

    it("recomputes the target's delay from its last attempt with its backoff", async () => {
      const P: BackoffParams = { free: 2, baseDelayMs: 1000, maxDelayMs: 300_000 };
      const { store, made } = recording();
      await store.attempt('login', [gate('ip', P)], [], 0);
      await store.attempt('login', [gate('ip', P)], [], 0);
      await store.attempt('login', [gate('ip', P)], [], 1000);
      await store.attempt('login', [gate('ip', P)], ['alice'], 3000);
      await store.succeed('login', [{ targets: [gate('ip', P)], by: ['alice'] }], [], 4000);
      expect(made.get('login')!.row('ip')).to.include({ attempts: 3, lastMs: 3000, nextMs: 5000 });
      expectRefused(await store.attempt('login', [gate('ip', P)], [], 4000), 1);
    });

    it('recomputes a target without by rows, with the backoff it is given', async () => {
      const { store, made } = recording({ delay: (p, n) => n * p.baseDelayMs });
      await store.attempt('login', [gate('ip', { free: 1, baseDelayMs: 100, maxDelayMs: 100 })], [], 5000);
      await store.succeed('login', [{ targets: [gate('ip', { free: 1, baseDelayMs: 300, maxDelayMs: 300 })], by: [] }], [], 6000);
      expect(made.get('login')!.row('ip')).to.include({ attempts: 1, nextMs: 5300 });
    });

    it('touches only its own flow', async () => {
      const { store, made } = recording();
      await store.attempt('mfa', [gate('ip', IP)], ['alice'], 0);
      await store.attempt('login', [gate('ip', IP)], ['alice'], 0);
      await store.succeed('login', [{ targets: [gate('ip', IP)], by: ['alice'] }], [], 0);
      expect(made.get('mfa')!.size).to.equal(2);
    });
  });

  describe('succeed: clear', () => {
    it('deletes the rows of its flow', async () => {
      const { store, made } = recording();
      for (const f of ['login', 'mfa']) await store.attempt(f, [gate('a'), gate('b')], ['c'], 0);
      await store.succeed('login', [], ['a', 'c', 'missing'], 0);
      expect([...made.get('login')!.entries()].map(([k]) => k)).to.deep.equal(['b']);
      expect(made.get('mfa')!.size).to.equal(3);
    });

    it('ends the hold-off of a nearly full table at once, even with no ids', async () => {
      const store = make({ maxRows: 200 });
      for (let i = 0; i < 199; i++) expectAllowed(await store.attempt('login', [gate(`held${i}`, LONG)], [], 0));
      expectAllowed(await store.attempt('login', [gate('idle')], [], 0));
      expectAllowed(await store.attempt('login', [gate('x')], [], 0), 'evicts idle, less than the slack');
      expectRefused(await store.attempt('login', [gate('y')], [], 0), 1, 'held off without a rescan');
      await store.succeed('login', [], [], 0);
      expectAllowed(await store.attempt('login', [gate('y')], [], 0), 'rescans and evicts x');
    });

    it('a clear of its ids makes room at once', async () => {
      const store = make({ maxRows: 4 });
      for (const id of ['a1', 'a2', 'a3', 'a4']) expectAllowed(await store.attempt('login', [gate(id, LONG)], [], 0));
      expectRefused(await store.attempt('login', [gate('a5', LONG)], [], 0), 600);
      await store.succeed('login', [], ['a1'], 0);
      expectAllowed(await store.attempt('login', [gate('a5', LONG)], [], 0));
    });
  });

  describe('succeed: one atomic step', () => {
    const IP: BackoffParams = { free: 6, baseDelayMs: 1000, maxDelayMs: 300_000 };

    it('lowers before it clears, so a by id listed in clear still counts', async () => {
      const { store, made } = recording();
      for (let i = 0; i < 3; i++) await store.attempt('login', [gate('ip', IP), gate('acct')], ['pair'], 0);
      await store.succeed('login', [{ targets: [gate('ip', IP)], by: ['pair'] }], ['acct', 'pair'], 0);
      expect(made.get('login')!.size).to.equal(0);
    });

    it('applies every rule in the call itself: no attempt can land between lower and clear', async () => {
      const { store, made } = recording();
      const calls = [
        store.attempt('login', [gate('ip', IP), gate('acct')], ['pair'], 0),
        store.attempt('login', [gate('ip', IP), gate('acct')], ['pair'], 0),
        store.succeed('login', [{ targets: [gate('ip', IP)], by: ['pair'] }], ['acct'], 0),
      ];
      // Not awaited yet: the rows already show the whole success.
      expect(made.get('login')!.size).to.equal(0);
      await Promise.all(calls);
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
