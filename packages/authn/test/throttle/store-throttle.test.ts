import assert from 'node:assert/strict';
import 'mocha';
import { InvalidArgument, InvalidOperation } from '@spinajs/exceptions';
import type { KeyedBackoffVerdict, ThrottleFlowRules, ThrottleGate, ThrottleLower, ThrottleStore } from '@spinajs/util';

import { DEFAULT_THROTTLE_PARAMS, StoreAuthnThrottle } from '../../src/index.js';
import type { AuthnContext, BackoffParams, ThrottleFlow, ThrottleKey, ThrottleParams } from '../../src/index.js';

type Call = { op: string; flow: string; gates?: readonly ThrottleGate[]; counted?: readonly string[]; lower?: readonly ThrottleLower[]; clear?: readonly string[]; nowMs: number };

class RecordingStore implements ThrottleStore {
  readonly calls: Call[] = [];
  async attempt(flow: string, gates: readonly ThrottleGate[], counted: readonly string[], nowMs: number): Promise<KeyedBackoffVerdict> {
    this.calls.push({ op: 'attempt', flow, gates, counted, nowMs });
    return { allowed: false, retryAfterSeconds: 3 };
  }
  async peek(flow: string, gates: readonly ThrottleGate[], nowMs: number): Promise<KeyedBackoffVerdict> {
    this.calls.push({ op: 'peek', flow, gates, nowMs });
    return { allowed: true };
  }
  async succeed(flow: string, lower: readonly ThrottleLower[], clear: readonly string[], nowMs: number): Promise<void> {
    this.calls.push({ op: 'succeed', flow, lower, clear, nowMs });
  }
}

class Recording extends StoreAuthnThrottle {
  readonly recording = new RecordingStore();
  stores = 0;
  constructor(protected readonly params: ThrottleParams) {
    super();
  }
  table(): Record<ThrottleFlow, ThrottleFlowRules> {
    return this.rules(this.params);
  }
  protected async store(): Promise<ThrottleStore> {
    this.stores++;
    return this.recording;
  }
  protected keyId(flow: ThrottleFlow, key: ThrottleKey): string {
    return `${flow}:${key.kind}:${key.value}`;
  }
}

const backoff = (free: number): BackoffParams => ({ free, baseDelayMs: 1000, maxDelayMs: 60_000 });
const ACCOUNT = backoff(5);
const IP = backoff(20);
const GLOBAL = backoff(100);
const PARAMS: ThrottleParams = { login: { account: ACCOUNT, ip: IP }, mfa: { account: ACCOUNT, ip: IP }, reset: { account: ACCOUNT, ip: IP }, reauth: { account: ACCOUNT }, resetAfterSeconds: 60, global: null };

const keys: ThrottleKey[] = [
  { kind: 'account', value: 'alice' },
  { kind: 'ip', value: '192.0.2.1' },
  { kind: 'account-ip', value: 'alice|192.0.2.1' },
];
const ctx = (now: Date): AuthnContext => ({ now, purpose: 'login' });
const invalid = (message: RegExp) => (e: unknown): boolean => e instanceof InvalidArgument && message.test(e.message);

describe('StoreAuthnThrottle', () => {
  describe('rules (the flow-rule table)', () => {
    const withIp: ThrottleFlowRules = {
      gates: { account: ACCOUNT, ip: IP },
      counted: ['account-ip'],
      onSuccess: { lower: [{ kind: 'ip', by: 'account-ip' }], clear: ['account', 'account-ip'] },
    };

    it('login and mfa gate account and ip, count account-ip, lower ip by it and clear account and account-ip on success', () => {
      const t = new Recording(PARAMS).table();
      assert.deepStrictEqual(t.login, withIp);
      assert.deepStrictEqual(t.mfa, withIp);
    });

    it('reauth without ip params gates the account only and only clears on success', () => {
      assert.deepStrictEqual(new Recording(PARAMS).table().reauth, { gates: { account: ACCOUNT }, onSuccess: { clear: ['account', 'account-ip'] } });
    });

    it('reset gates and counts as the other flows, but a success clears nothing', () => {
      assert.deepStrictEqual(new Recording(PARAMS).table().reset, { gates: { account: ACCOUNT, ip: IP }, counted: ['account-ip'] });
    });

    it('every flow gates global when it is set', () => {
      const t = new Recording({ ...PARAMS, global: GLOBAL }).table();
      assert.deepStrictEqual(t.login.gates, { account: ACCOUNT, ip: IP, global: GLOBAL });
      assert.deepStrictEqual(t.reauth.gates, { account: ACCOUNT, global: GLOBAL });
      assert.deepStrictEqual(t.reset.gates, { account: ACCOUNT, ip: IP, global: GLOBAL });
    });

    it('covers every flow of the defaults', () => {
      assert.deepStrictEqual(Object.keys(new Recording(DEFAULT_THROTTLE_PARAMS).table()).sort(), ['login', 'mfa', 'reauth', 'reset']);
    });
  });

  describe('delegation', () => {
    it('attempts and peeks at ctx.now with ids from keyId, and returns the store verdict', async () => {
      const t = new Recording(PARAMS);
      const now = new Date('2026-10-01T12:00:00.000Z');
      assert.deepStrictEqual(await t.attempt(keys, 'login', ctx(now)), { allowed: false, retryAfterSeconds: 3 });
      assert.deepStrictEqual(await t.peek(keys, 'mfa', ctx(now)), { allowed: true });
      assert.deepStrictEqual(t.recording.calls, [
        { op: 'attempt', flow: 'login', gates: [{ id: 'login:account:alice', backoff: ACCOUNT }, { id: 'login:ip:192.0.2.1', backoff: IP }], counted: ['login:account-ip:alice|192.0.2.1'], nowMs: now.getTime() },
        { op: 'peek', flow: 'mfa', gates: [{ id: 'mfa:account:alice', backoff: ACCOUNT }, { id: 'mfa:ip:192.0.2.1', backoff: IP }], nowMs: now.getTime() },
      ]);
    });

    it('succeeds in one store call, and not at all for reset', async () => {
      const t = new Recording(PARAMS);
      const before = Date.now();
      await t.succeed(keys, 'login');
      await t.succeed(keys, 'reset');
      const [call, ...rest] = t.recording.calls;
      assert.deepStrictEqual(rest, []);
      assert.deepStrictEqual({ ...call, nowMs: 0 }, {
        op: 'succeed',
        flow: 'login',
        lower: [{ targets: [{ id: 'login:ip:192.0.2.1', backoff: IP }], by: ['login:account-ip:alice|192.0.2.1'] }],
        clear: ['login:account:alice', 'login:account-ip:alice|192.0.2.1'],
        nowMs: 0,
      });
      assert.ok(call.nowMs >= before && call.nowMs <= Date.now(), 'succeed takes the clock');
    });

    it('builds the store once, on first use', async () => {
      const t = new Recording(PARAMS);
      assert.strictEqual(t.stores, 0);
      await Promise.all([t.attempt(keys, 'login', ctx(new Date())), t.peek(keys, 'login', ctx(new Date())), t.succeed(keys, 'login')]);
      assert.strictEqual(t.stores, 1);
    });

    it('rejects a ctx without a valid now and an unknown flow before the store is called', async () => {
      const t = new Recording(PARAMS);
      for (const bad of [new Date(NaN), undefined as unknown as Date]) {
        await assert.rejects(t.attempt(keys, 'login', ctx(bad)), InvalidArgument);
        await assert.rejects(t.peek(keys, 'login', ctx(bad)), InvalidArgument);
      }
      await assert.rejects(t.attempt(keys, 'signup' as ThrottleFlow, ctx(new Date())), InvalidArgument);
      await assert.rejects(t.succeed(keys, 'signup' as ThrottleFlow), InvalidArgument);
      assert.deepStrictEqual(t.recording.calls, []);
    });

    it('rejects a bad ctx, then an unknown flow, before it reads the params or builds the store', async () => {
      const t = new Unconfigured();
      await assert.rejects(t.attempt(keys, 'signup' as ThrottleFlow, ctx(new Date(NaN))), invalid(/^Unconfigured\.attempt: ctx\.now/));
      await assert.rejects(t.peek(keys, 'signup' as ThrottleFlow, ctx(new Date(NaN))), invalid(/^Unconfigured\.peek: ctx\.now/));
      for (const run of [() => t.attempt(keys, 'signup' as ThrottleFlow, ctx(new Date())), () => t.peek(keys, 'signup' as ThrottleFlow, ctx(new Date())), () => t.succeed(keys, 'signup' as ThrottleFlow)]) {
        await assert.rejects(run(), invalid(/^Unconfigured: unknown flow "signup"$/));
      }
      assert.deepStrictEqual({ reads: t.reads, stores: t.stores }, { reads: 0, stores: 0 });
      await assert.rejects(t.attempt(keys, 'login', ctx(new Date())), InvalidOperation);
    });

    it('names itself in the errors of its Throttle', async () => {
      const t = new Recording(PARAMS);
      await assert.rejects(t.attempt([{ kind: 'ip', value: 42 as unknown as string }], 'login', ctx(new Date())), { message: 'Recording: the value of a "ip" key must be a string' });
    });
  });
});

class Unconfigured extends StoreAuthnThrottle {
  reads = 0;
  stores = 0;
  protected get params(): ThrottleParams {
    this.reads++;
    throw new InvalidOperation('authn.throttle is unset');
  }
  protected async store(): Promise<ThrottleStore> {
    this.stores++;
    return new RecordingStore();
  }
  protected keyId(flow: ThrottleFlow, key: ThrottleKey): string {
    return `${flow}:${key.kind}:${key.value}`;
  }
}

describe('@spinajs/authn/store-throttle', () => {
  it('exports the StoreAuthnThrottle of the root entry', async () => {
    const root = await import('@spinajs/authn');
    const sub = await import('@spinajs/authn/store-throttle');
    assert.strictEqual(sub.StoreAuthnThrottle, root.StoreAuthnThrottle);
  });
});
