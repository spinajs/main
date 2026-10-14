import { expect } from 'chai';
import { InvalidArgument } from '@spinajs/exceptions';
import { Throttle } from '../src/index.js';
import type { BackoffParams, KeyedBackoffVerdict, ThrottleFlowRules, ThrottleGate, ThrottleKey, ThrottleStore } from '../src/index.js';

const ACCOUNT: BackoffParams = { free: 5, baseDelayMs: 1000, maxDelayMs: 60_000 };
const IP: BackoffParams = { free: 50, baseDelayMs: 1000, maxDelayMs: 300_000 };

type Call =
  | { op: 'attempt'; flow: string; gates: readonly ThrottleGate[]; counted: readonly string[]; nowMs: number }
  | { op: 'peek'; flow: string; gates: readonly ThrottleGate[]; nowMs: number }
  | { op: 'lower'; flow: string; targets: readonly ThrottleGate[]; by: readonly string[]; nowMs: number }
  | { op: 'clear'; flow: string; ids: readonly string[]; nowMs: number };

class RecordingStore implements ThrottleStore {
  readonly calls: Call[] = [];
  verdict: KeyedBackoffVerdict = { allowed: true };

  async attempt(flow: string, gates: readonly ThrottleGate[], counted: readonly string[], nowMs: number): Promise<KeyedBackoffVerdict> {
    this.calls.push({ op: 'attempt', flow, gates, counted, nowMs });
    return this.verdict;
  }
  async peek(flow: string, gates: readonly ThrottleGate[], nowMs: number): Promise<KeyedBackoffVerdict> {
    this.calls.push({ op: 'peek', flow, gates, nowMs });
    return this.verdict;
  }
  async lower(flow: string, targets: readonly ThrottleGate[], by: readonly string[], nowMs: number): Promise<void> {
    this.calls.push({ op: 'lower', flow, targets, by, nowMs });
  }
  async clear(flow: string, ids: readonly string[], nowMs: number): Promise<void> {
    this.calls.push({ op: 'clear', flow, ids, nowMs });
  }
}

const LOGIN: ThrottleFlowRules = {
  gates: { account: ACCOUNT, ip: IP },
  counted: ['account-ip'],
  onSuccess: { lower: [{ kind: 'ip', by: 'account-ip' }], clear: ['account', 'account-ip'] },
};
const RESET: ThrottleFlowRules = { gates: { account: ACCOUNT, ip: IP } };

const keys = (account: string, ip: string): ThrottleKey[] => [
  { kind: 'account', value: account },
  { kind: 'ip', value: ip },
  { kind: 'account-ip', value: `${ip}/${account}` },
];

function make(flows: Record<string, ThrottleFlowRules> = { login: LOGIN, reset: RESET }, keyId?: (flow: string, key: ThrottleKey) => string) {
  const store = new RecordingStore();
  return { store, throttle: new Throttle({ flows, store, keyId }) };
}

async function rejectsWith(p: Promise<unknown>, type: new (...args: never[]) => Error): Promise<void> {
  try {
    await p;
  } catch (e) {
    expect(e).to.be.instanceOf(type);
    return;
  }
  expect.fail('expected a rejection');
}

describe('Throttle', () => {
  describe('attempt', () => {
    it('passes gate kinds as gates with their backoff and counted kinds as counted ids', async () => {
      const { store, throttle } = make();
      expect(await throttle.attempt(keys('alice', '10.0.0.1'), 'login', 7)).to.deep.equal({ allowed: true });
      expect(store.calls).to.deep.equal([
        {
          op: 'attempt',
          flow: 'login',
          gates: [
            { id: 'login|account|alice', backoff: ACCOUNT },
            { id: 'login|ip|10.0.0.1', backoff: IP },
          ],
          counted: ['login|account-ip|10.0.0.1/alice'],
          nowMs: 7,
        },
      ]);
    });

    it("returns the store's verdict", async () => {
      const { store, throttle } = make();
      store.verdict = { allowed: false, retryAfterSeconds: 9 };
      expect(await throttle.attempt(keys('alice', '10.0.0.1'), 'login', 0)).to.deep.equal({ allowed: false, retryAfterSeconds: 9 });
    });

    it('ignores kinds the flow neither gates nor counts', async () => {
      const { store, throttle } = make();
      await throttle.attempt([{ kind: 'global', value: 'g' }, { kind: 'account', value: 'alice' }, { kind: 'device', value: 'd' }], 'login', 0);
      expect(store.calls).to.deep.equal([{ op: 'attempt', flow: 'login', gates: [{ id: 'login|account|alice', backoff: ACCOUNT }], counted: [], nowMs: 0 }]);
    });

    it('does not count a kind of a flow without counted', async () => {
      const { store, throttle } = make();
      await throttle.attempt(keys('alice', '10.0.0.1'), 'reset', 0);
      expect(store.calls[0]).to.include({ op: 'attempt' }).and.to.have.property('counted').that.deep.equals([]);
    });

    it('ignores a kind inherited from Object.prototype', async () => {
      const { store, throttle } = make();
      await throttle.attempt([{ kind: 'toString', value: 'x' }, { kind: 'constructor', value: 'y' }], 'login', 0);
      expect(store.calls).to.deep.equal([{ op: 'attempt', flow: 'login', gates: [], counted: [], nowMs: 0 }]);
    });

    it('de-duplicates ids', async () => {
      const { store, throttle } = make();
      await throttle.attempt([...keys('alice', '10.0.0.1'), ...keys('alice', '10.0.0.1')], 'login', 0);
      const call = store.calls[0] as Extract<Call, { op: 'attempt' }>;
      expect(call.gates.map((g) => g.id)).to.deep.equal(['login|account|alice', 'login|ip|10.0.0.1']);
      expect(call.counted).to.deep.equal(['login|account-ip|10.0.0.1/alice']);
    });

    it('lets the gate win when an id is both gating and counted', async () => {
      const { store, throttle } = make(undefined, (_flow, key) => key.value);
      await throttle.attempt([{ kind: 'account-ip', value: 'same' }, { kind: 'account', value: 'same' }, { kind: 'account-ip', value: 'other' }], 'login', 0);
      expect(store.calls).to.deep.equal([{ op: 'attempt', flow: 'login', gates: [{ id: 'same', backoff: ACCOUNT }], counted: ['other'], nowMs: 0 }]);
    });

    it('keys ids through keyId with the flow and the key', async () => {
      const seen: [string, ThrottleKey][] = [];
      const { store, throttle } = make(undefined, (flow, key) => {
        seen.push([flow, key]);
        return `h:${key.kind}:${key.value}`;
      });
      await throttle.attempt([{ kind: 'account', value: 'alice' }, { kind: 'device', value: 'd' }], 'login', 0);
      expect(seen).to.deep.equal([['login', { kind: 'account', value: 'alice' }]]);
      expect((store.calls[0] as Extract<Call, { op: 'attempt' }>).gates).to.deep.equal([{ id: 'h:account:alice', backoff: ACCOUNT }]);
    });
  });

  describe('peek', () => {
    it('passes only gates and counts nothing', async () => {
      const { store, throttle } = make();
      store.verdict = { allowed: false, retryAfterSeconds: 3 };
      expect(await throttle.peek(keys('alice', '10.0.0.1'), 'login', 5)).to.deep.equal({ allowed: false, retryAfterSeconds: 3 });
      expect(store.calls).to.deep.equal([
        {
          op: 'peek',
          flow: 'login',
          gates: [
            { id: 'login|account|alice', backoff: ACCOUNT },
            { id: 'login|ip|10.0.0.1', backoff: IP },
          ],
          nowMs: 5,
        },
      ]);
    });

    it('does not validate a counted key it ignores', async () => {
      const { store, throttle } = make();
      await throttle.peek([{ kind: 'account-ip', value: 42 as unknown as string }], 'login', 0);
      expect(store.calls).to.have.length(1);
    });
  });

  describe('succeed', () => {
    it('lowers each rule, then clears the listed kinds', async () => {
      const { store, throttle } = make();
      await throttle.succeed(keys('alice', '10.0.0.1'), 'login', 11);
      expect(store.calls).to.deep.equal([
        { op: 'lower', flow: 'login', targets: [{ id: 'login|ip|10.0.0.1', backoff: IP }], by: ['login|account-ip|10.0.0.1/alice'], nowMs: 11 },
        { op: 'clear', flow: 'login', ids: ['login|account|alice', 'login|account-ip|10.0.0.1/alice'], nowMs: 11 },
      ]);
    });

    it('runs the lower rules in order, each with its own kinds', async () => {
      const { store, throttle } = make({
        f: {
          gates: { a: ACCOUNT, b: IP },
          counted: ['x', 'y'],
          onSuccess: {
            lower: [
              { kind: 'b', by: 'y' },
              { kind: 'a', by: 'x' },
            ],
          },
        },
      });
      await throttle.succeed(
        [
          { kind: 'a', value: '1' },
          { kind: 'b', value: '2' },
          { kind: 'x', value: '3' },
          { kind: 'y', value: '4' },
        ],
        'f',
        0,
      );
      expect(store.calls).to.deep.equal([
        { op: 'lower', flow: 'f', targets: [{ id: 'f|b|2', backoff: IP }], by: ['f|y|4'], nowMs: 0 },
        { op: 'lower', flow: 'f', targets: [{ id: 'f|a|1', backoff: ACCOUNT }], by: ['f|x|3'], nowMs: 0 },
      ]);
    });

    it('skips a lower rule no key matches', async () => {
      const { store, throttle } = make();
      await throttle.succeed([{ kind: 'account', value: 'alice' }], 'login', 0);
      expect(store.calls).to.deep.equal([{ op: 'clear', flow: 'login', ids: ['login|account|alice'], nowMs: 0 }]);
    });

    it('lowers a target without by keys, and consumes by keys without a target', async () => {
      const { store, throttle } = make();
      await throttle.succeed([{ kind: 'ip', value: '10.0.0.1' }], 'login', 0);
      await throttle.succeed([{ kind: 'account-ip', value: 'p' }], 'login', 0);
      expect(store.calls.filter((c) => c.op === 'lower')).to.deep.equal([
        { op: 'lower', flow: 'login', targets: [{ id: 'login|ip|10.0.0.1', backoff: IP }], by: [], nowMs: 0 },
        { op: 'lower', flow: 'login', targets: [], by: ['login|account-ip|p'], nowMs: 0 },
      ]);
    });

    it('still clears with no matching key: a store may end a full-table refusal there', async () => {
      const { store, throttle } = make();
      await throttle.succeed([], 'login', 0);
      expect(store.calls).to.deep.equal([{ op: 'clear', flow: 'login', ids: [], nowMs: 0 }]);
    });

    it('de-duplicates the ids it passes', async () => {
      const { store, throttle } = make();
      await throttle.succeed([...keys('alice', '10.0.0.1'), ...keys('alice', '10.0.0.1')], 'login', 0);
      expect(store.calls).to.deep.equal([
        { op: 'lower', flow: 'login', targets: [{ id: 'login|ip|10.0.0.1', backoff: IP }], by: ['login|account-ip|10.0.0.1/alice'], nowMs: 0 },
        { op: 'clear', flow: 'login', ids: ['login|account|alice', 'login|account-ip|10.0.0.1/alice'], nowMs: 0 },
      ]);
    });

    it('does nothing for a flow without onSuccess', async () => {
      const { store, throttle } = make();
      await throttle.succeed(keys('alice', '10.0.0.1'), 'reset', 0);
      expect(store.calls).to.deep.equal([]);
    });
  });

  describe('validation', () => {
    it('rejects an unknown flow before the store is called', async () => {
      const { store, throttle } = make();
      await rejectsWith(throttle.attempt(keys('a', 'b'), 'signup', 0), InvalidArgument);
      await rejectsWith(throttle.peek(keys('a', 'b'), 'signup', 0), InvalidArgument);
      await rejectsWith(throttle.succeed(keys('a', 'b'), 'signup', 0), InvalidArgument);
      await rejectsWith(throttle.attempt(keys('a', 'b'), 'toString', 0), InvalidArgument);
      expect(store.calls).to.deep.equal([]);
    });

    it('rejects a key value that is not a string before the store is called', async () => {
      const { store, throttle } = make();
      const bad = (kind: string): ThrottleKey[] => [{ kind: 'account', value: 'alice' }, { kind, value: 42 as unknown as string }];
      await rejectsWith(throttle.attempt(bad('ip'), 'login', 0), InvalidArgument);
      await rejectsWith(throttle.attempt(bad('account-ip'), 'login', 0), InvalidArgument);
      await rejectsWith(throttle.peek(bad('ip'), 'login', 0), InvalidArgument);
      await rejectsWith(throttle.succeed(bad('ip'), 'login', 0), InvalidArgument);
      await rejectsWith(throttle.succeed(bad('account-ip'), 'login', 0), InvalidArgument);
      expect(store.calls).to.deep.equal([]);
    });

    it('rejects a non-finite nowMs before the store is called', async () => {
      const { store, throttle } = make();
      for (const nowMs of [NaN, Infinity, '0' as unknown as number]) {
        await rejectsWith(throttle.attempt(keys('a', 'b'), 'login', nowMs), InvalidArgument);
        await rejectsWith(throttle.peek(keys('a', 'b'), 'login', nowMs), InvalidArgument);
        await rejectsWith(throttle.succeed(keys('a', 'b'), 'login', nowMs), InvalidArgument);
      }
      expect(store.calls).to.deep.equal([]);
    });

    it('rejects a lower rule whose kind does not gate, at construction', () => {
      const store = new RecordingStore();
      expect(() => new Throttle({ store, flows: { f: { gates: { a: ACCOUNT }, onSuccess: { lower: [{ kind: 'b', by: 'a' }] } } } })).to.throw(InvalidArgument, /f.*b/);
    });
  });
});
