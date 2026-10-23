import { expect } from 'chai';
import { Throttle } from '../src/index.js';
import type { BackoffParams, KeyedBackoffVerdict, ThrottleFlowRules, ThrottleGate, ThrottleKey, ThrottleLower, ThrottleStore } from '../src/index.js';

const ACCOUNT: BackoffParams = { free: 5, baseDelayMs: 1000, maxDelayMs: 60_000 };
const IP: BackoffParams = { free: 50, baseDelayMs: 1000, maxDelayMs: 300_000 };

type Call =
  | { op: 'attempt'; flow: string; gates: readonly ThrottleGate[]; counted: readonly string[]; nowMs: number }
  | { op: 'peek'; flow: string; gates: readonly ThrottleGate[]; nowMs: number }
  | { op: 'succeed'; flow: string; lower: readonly ThrottleLower[]; clear: readonly string[]; nowMs: number };

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
  async succeed(flow: string, lower: readonly ThrottleLower[], clear: readonly string[], nowMs: number): Promise<void> {
    this.calls.push({ op: 'succeed', flow, lower, clear, nowMs });
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

describe('Throttle', () => {
  describe('attempt', () => {

    it('lets the gate win when an id is both gating and counted', async () => {
      const { store, throttle } = make(undefined, (_flow, key) => key.value);
      await throttle.attempt([{ kind: 'account-ip', value: 'same' }, { kind: 'account', value: 'same' }, { kind: 'account-ip', value: 'other' }], 'login', 0);
      expect(store.calls).to.deep.equal([{ op: 'attempt', flow: 'login', gates: [{ id: 'same', backoff: ACCOUNT }], counted: ['other'], nowMs: 0 }]);
    });
  });

  describe('succeed', () => {

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
        {
          op: 'succeed',
          flow: 'f',
          lower: [
            { targets: [{ id: 'f|b|2', backoff: IP }], by: ['f|y|4'] },
            { targets: [{ id: 'f|a|1', backoff: ACCOUNT }], by: ['f|x|3'] },
          ],
          clear: [],
          nowMs: 0,
        },
      ]);
    });

    it('skips a lower rule no key matches', async () => {
      const { store, throttle } = make();
      await throttle.succeed([{ kind: 'account', value: 'alice' }], 'login', 0);
      expect(store.calls).to.deep.equal([{ op: 'succeed', flow: 'login', lower: [], clear: ['login|account|alice'], nowMs: 0 }]);
    });

    it('lowers a target without by keys, and consumes by keys without a target', async () => {
      const { store, throttle } = make();
      await throttle.succeed([{ kind: 'ip', value: '10.0.0.1' }], 'login', 0);
      await throttle.succeed([{ kind: 'account-ip', value: 'p' }], 'login', 0);
      expect(store.calls.map((c) => (c as Extract<Call, { op: 'succeed' }>).lower)).to.deep.equal([
        [{ targets: [{ id: 'login|ip|10.0.0.1', backoff: IP }], by: [] }],
        [{ targets: [], by: ['login|account-ip|p'] }],
      ]);
    });

    it('does nothing for a flow without onSuccess', async () => {
      const { store, throttle } = make();
      await throttle.succeed(keys('alice', '10.0.0.1'), 'reset', 0);
      expect(store.calls).to.deep.equal([]);
    });
  });

  describe('validation', () => {

    it('names the throttle in its errors, Throttle by default', async () => {
      const messages = async (name?: string): Promise<string[]> => {
        const store = new RecordingStore();
        const throttle = new Throttle({ store, flows: { login: LOGIN }, name });
        const out: string[] = [];
        for (const p of [throttle.attempt([], 'signup', 0), throttle.attempt([{ kind: 'ip', value: 42 as unknown as string }], 'login', 0), throttle.peek([], 'login', NaN)]) {
          await p.catch((e: Error) => out.push(e.message));
        }
        try {
          new Throttle({ store, flows: { f: { gates: {}, onSuccess: { lower: [{ kind: 'b', by: 'a' }] } } }, name });
        } catch (e) {
          out.push((e as Error).message);
        }
        return out;
      };
      expect(await messages()).to.deep.equal(['Throttle: unknown flow "signup"', 'Throttle: the value of a "ip" key must be a string', 'Throttle: nowMs must be a finite number', 'Throttle: flow "f" lowers "b", which it does not gate']);
      expect(await messages('DbAuthnThrottle')).to.deep.equal(['DbAuthnThrottle: unknown flow "signup"', 'DbAuthnThrottle: the value of a "ip" key must be a string', 'DbAuthnThrottle: nowMs must be a finite number', 'DbAuthnThrottle: flow "f" lowers "b", which it does not gate']);
    });
  });
});
